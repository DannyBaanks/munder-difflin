// Top-level build: mismas versiones para todo el módulo.
// Espejo de ios/MunderMobile/project.yml: bundle mx.isyco.munder.mobile, version 0.1.0.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.20" apply false
    // Capturas en JVM sin emulador (los runners hospedados no tienen KVM ni HVF).
    id("io.github.takahirom.roborazzi") version "1.16.0" apply false
}
