plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("io.github.takahirom.roborazzi")
}

android {
    namespace = "mx.isyco.munder.mobile"
    compileSdk = 36

    defaultConfig {
        // MISMO bundle que iOS (project.yml): mx.isyco.munder.mobile.
        // El core lleva el mismo sufijo que MunderMobileCore.
        applicationId = "mx.isyco.munder.mobile"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        vectorDrawables { useSupportLibrary = true }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            // Sufijo visible para no confundir el APK de pruebas con el de uso.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures { compose = true }

    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            // BouncyCastle trae firmas que el APK no necesita.
            excludes += "META-INF/*.SF"
            excludes += "META-INF/*.DSA"
            excludes += "META-INF/*.RSA"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")
    // La red va en Dispatchers.IO (RemoteClient.post): corrutinas explícitas.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.material:material-icons-extended")

    // Red: mismos timeouts que iOS (3.5 s por dirección, 8 s emparejando).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON snake_case igual que lib-remote.cjs.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Cripto munder-remote@1: X25519 + HKDF-SHA256 + ChaCha20-Poly1305.
    // BouncyCastle puro-Java para que el cálculo sea idéntico en todos los móviles.
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // Keystore cifrado = el Keychain de iOS.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    // Huella / PIN = Face ID / código.
    implementation("androidx.biometric:biometric:1.1.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    // Capturas: Compose en JVM (Roborazzi sobre Robolectric), sin emulador.
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.16.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.16.0")
    testImplementation("org.robolectric:robolectric:4.17")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
}

android {
    // Roborazzi necesita los recursos Android en los tests unitarios.
    testOptions {
        unitTests { isIncludeAndroidResources = true }
    }
}
