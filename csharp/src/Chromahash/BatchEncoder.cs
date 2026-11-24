using System.Collections.Concurrent;

namespace ChromaHash;

/// <summary>One image to encode in a batch.</summary>
/// <param name="Width">Image width (>= 1).</param>
/// <param name="Height">Image height (>= 1).</param>
/// <param name="Rgba">Pixel data in RGBA format (4 bytes per pixel, row-major).</param>
/// <param name="Gamut">Source color space.</param>
/// <param name="Quality">
/// Quality tier (0..=<see cref="ChromaHash.MaxTier"/>, ordered by quality).
/// Defaults to <see cref="ChromaHash.DefaultTier"/>, matching
/// <see cref="ChromaHash.Encode"/>.
/// </param>
public readonly record struct ImageInput(
    uint Width,
    uint Height,
    byte[] Rgba,
    Gamut Gamut,
    byte Quality = ChromaHash.DefaultTier
);

/// <summary>
/// Stateful, self-parallelizing batch encoder backed by an owned pool of worker
/// threads (sized to <see cref="Environment.ProcessorCount"/>, reused across
/// calls). Construct one, reuse it across many <see cref="EncodeBatch"/> calls,
/// then release it with <see cref="Dispose"/>.
/// </summary>
/// <remarks>
/// Output is byte-identical to calling <see cref="ChromaHash.EncodeWithQuality"/>
/// on each image individually at that image's tier.
/// </remarks>
public sealed class BatchEncoder : IDisposable
{
    private readonly BlockingCollection<WorkItem> _jobs = new();
    private readonly Thread[] _workers;
    private bool _disposed;

    private readonly record struct WorkItem(
        int Index,
        ImageInput Input,
        ChromaHash[] Output,
        CountdownEvent Done
    );

    /// <summary>Create an encoder with a worker pool sized to the processor count.</summary>
    public BatchEncoder()
        : this(Environment.ProcessorCount) { }

    /// <summary>Create an encoder with an explicit worker count (clamped to >= 1).</summary>
    public BatchEncoder(int threads)
    {
        int n = Math.Max(1, threads);
        _workers = new Thread[n];
        for (int i = 0; i < n; i++)
        {
            _workers[i] = new Thread(WorkerLoop)
            {
                IsBackground = true,
                Name = $"chromahash-batch-{i}",
            };
            _workers[i].Start();
        }
    }

    private void WorkerLoop()
    {
        foreach (var job in _jobs.GetConsumingEnumerable())
        {
            var it = job.Input;
            job.Output[job.Index] = ChromaHash.EncodeWithQuality(
                it.Width,
                it.Height,
                it.Rgba,
                it.Gamut,
                it.Quality
            );
            job.Done.Signal();
        }
    }

    /// <summary>
    /// Encode every item, returning hashes in the same order as <paramref name="items"/>.
    /// </summary>
    /// <remarks>
    /// All items are validated up front, before any work is dispatched, so an
    /// invalid item throws on the calling thread (identifying its index) rather
    /// than failing a worker mid-flight. Validation matches
    /// <see cref="ChromaHash.EncodeWithQuality"/>.
    /// </remarks>
    public ChromaHash[] EncodeBatch(IReadOnlyList<ImageInput> items)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentNullException.ThrowIfNull(items);

        for (int i = 0; i < items.Count; i++)
        {
            var it = items[i];
            if (it.Width < 1)
                throw new ArgumentOutOfRangeException(
                    nameof(items),
                    $"item {i}: width must be >= 1"
                );
            if (it.Height < 1)
                throw new ArgumentOutOfRangeException(
                    nameof(items),
                    $"item {i}: height must be >= 1"
                );
            if (it.Rgba.Length != (int)it.Width * (int)it.Height * 4)
                throw new ArgumentException($"item {i}: rgba length mismatch", nameof(items));
            if (it.Quality > ChromaHash.MaxTier)
                throw new ArgumentOutOfRangeException(
                    nameof(items),
                    $"item {i}: quality tier must be 0..={ChromaHash.MaxTier}"
                );
            if (!Enum.IsDefined(it.Gamut))
                throw new ArgumentOutOfRangeException(
                    nameof(items),
                    $"item {i}: gamut {(int)it.Gamut} is not a defined Gamut"
                );
        }

        var output = new ChromaHash[items.Count];
        if (items.Count == 0)
            return output;

        using var done = new CountdownEvent(items.Count);
        for (int i = 0; i < items.Count; i++)
            _jobs.Add(new WorkItem(i, items[i], output, done));
        done.Wait();
        return output;
    }

    /// <summary>Shut the worker pool down and join its threads. Idempotent.</summary>
    public void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;
        _jobs.CompleteAdding();
        foreach (var t in _workers)
            t.Join();
        _jobs.Dispose();
    }
}
