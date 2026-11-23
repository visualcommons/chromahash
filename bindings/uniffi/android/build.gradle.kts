import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.SourcesJar
import java.io.File

plugins {
    // AGP 9.0+ has built-in Kotlin support, so the Kotlin Android plugin is NOT
    // applied separately. `src/main/kotlin` is a default source dir, which is
    // where uniffi-bindgen writes the generated ChromaHash bindings.
    id("com.android.library") version "9.1.1"
    // Publishes the AAR to Maven Central + GitHub Packages (see Publishing below).
    id("com.vanniktech.maven.publish") version "0.36.0"
}

// Maven coordinate group. This is the GitHub-verified Sonatype Central namespace
// and is INDEPENDENT of the Kotlin/Android package `io.chromahash.ffi`.
group = "io.github.visualcommons"
version = "0.8.0" // tracks the chromahash core crate version

android {
    namespace = "io.chromahash.ffi"
    compileSdk = 36

    defaultConfig {
        minSdk = 21
    }
    // NOTE: no `publishing { singleVariant("release") }` here — the vanniktech
    // plugin's AndroidSingleVariantLibrary (below) configures the release variant.
}

dependencies {
    // UniFFI's generated Kotlin uses JNA to call into the .so at runtime.
    // The `@aar` artifact bundles JNA's own native libraries for Android.
    implementation("net.java.dev.jna:jna:5.14.0@aar")
}

// ─── Native build pipeline ────────────────────────────────────────────────────
// The chromahash-uniffi crate lives one directory up. Both steps run with the
// crate dir as the working directory so `cargo metadata` (used by uniffi-bindgen)
// can locate Cargo.toml — there is no Cargo workspace at the repo root.

val crateDir: File = projectDir.parentFile
val abis = listOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")

/** Locate an Android NDK, preferring an explicit env var over the SDK's newest NDK. */
fun resolveNdkHome(): String =
    System.getenv("ANDROID_NDK_HOME")
        ?: System.getenv("ANDROID_NDK_LATEST_HOME")
        ?: System.getenv("ANDROID_HOME")?.let { sdk ->
            File(sdk, "ndk").takeIf { it.isDirectory }
                ?.listFiles { f -> f.isDirectory }
                ?.maxByOrNull { it.name }
                ?.absolutePath
        }
        ?: error(
            "Android NDK not found. Set ANDROID_NDK_HOME (or ANDROID_NDK_LATEST_HOME), " +
                "or install one via Android Studio → SDK Manager → SDK Tools → NDK.",
        )

// Cross-compile the cdylib into android/src/main/jniLibs/<abi>/ for every ABI.
val cargoNdkBuild by tasks.registering(Exec::class) {
    group = "build"
    description = "Cross-compile chromahash-uniffi for all Android ABIs via cargo-ndk."
    workingDir = crateDir
    // workingDir is the crate root, so cargo locates Cargo.toml without --manifest-path.
    val cmd = mutableListOf("cargo", "ndk")
    abis.forEach { cmd += listOf("-t", it) }
    cmd += listOf("-o", "android/src/main/jniLibs", "build", "--release")
    commandLine(cmd)
    // Resolve the NDK lazily so configuring the project doesn't require one.
    doFirst { environment("ANDROID_NDK_HOME", resolveNdkHome()) }
}

// Generate the Kotlin bindings from the compiled cdylib's embedded metadata.
val generateUniffiBindings by tasks.registering(Exec::class) {
    group = "build"
    description = "Generate Kotlin bindings from the compiled cdylib via uniffi-bindgen."
    dependsOn(cargoNdkBuild)
    workingDir = crateDir
    commandLine(
        "cargo", "run", "--bin", "uniffi-bindgen", "--",
        "generate", "android/src/main/jniLibs/arm64-v8a/libchromahash_uniffi.so",
        "--language", "kotlin",
        "--out-dir", "android/src/main/kotlin",
        "--config", "uniffi.toml",
        "--no-format",
    )
}

// Regenerate the .so + Kotlin before every build.
tasks.named("preBuild") {
    dependsOn(generateUniffiBindings)
}

// ─── Publishing ───────────────────────────────────────────────────────────────
// Two distribution channels (issue #17):
//   • Maven Central (Sonatype Central Portal) — the public, auth-free channel.
//   • GitHub Packages — a secondary mirror tied to this repo (consumers need a PAT).
// Local dev: `./gradlew publishToMavenLocal` (no signing/credentials needed).
// Coordinate: io.github.visualcommons:chromahash-android:<version>.
// The one-time Maven Central bootstrap (namespace, signing key, secrets) and the
// tag-driven release flow are documented in RELEASING.md.
mavenPublishing {
    // Argument-less in vanniktech 0.36.0 — already targets the Central Portal
    // (legacy OSSRH support was removed). CI runs publishAndReleaseToMavenCentral.
    publishToMavenCentral()
    signAllPublications()

    coordinates("io.github.visualcommons", "chromahash-android", version.toString())

    // Single "release" AAR variant. JavadocJar.Empty() ships an empty javadoc jar
    // (Central requires one; real javadoc is meaningless for generated Kotlin).
    configure(
        AndroidSingleVariantLibrary(
            javadocJar = JavadocJar.Empty(),
            sourcesJar = SourcesJar.Sources(),
            variant = "release",
        ),
    )

    pom {
        name.set("ChromaHash for Android")
        description.set(
            "Android binding for ChromaHash: the zero-dependency Rust core exposed to Kotlin " +
                "over JNI via UniFFI, packaged as an AAR for fast on-device placeholder decoding.",
        )
        inceptionYear.set("2026")
        url.set("https://github.com/visualcommons/chromahash")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://github.com/visualcommons/chromahash/blob/master/LICENSE-MIT")
                distribution.set("repo")
            }
            license {
                name.set("The Apache License, Version 2.0")
                url.set("https://github.com/visualcommons/chromahash/blob/master/LICENSE-APACHE")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("visualcommons")
                name.set("Justin Chung")
                email.set("noreply@justinchung.net")
                url.set("https://github.com/visualcommons")
            }
        }
        scm {
            url.set("https://github.com/visualcommons/chromahash")
            connection.set("scm:git:git://github.com/visualcommons/chromahash.git")
            developerConnection.set("scm:git:ssh://git@github.com/visualcommons/chromahash.git")
        }
    }
}

// Re-add GitHub Packages as a secondary target on the vanniktech-created
// publication. vanniktech owns the publications + signing; we only register the
// extra repository (CI sets GITHUB_ACTOR/GITHUB_TOKEN; locally set gpr.user/gpr.key).
publishing {
    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/visualcommons/chromahash")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: (findProperty("gpr.user") as String?)
                password = System.getenv("GITHUB_TOKEN") ?: (findProperty("gpr.key") as String?)
            }
        }
    }
}
