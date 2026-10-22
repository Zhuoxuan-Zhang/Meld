# Focus Grove

Generated Android source for the [Meld product demo](../../README.md). This snapshot matches the recorded tested build; it contains no base-app code, APKs, model logs or local credentials.

With JDK 17+ and Android SDK 35 configured in `ANDROID_HOME`, run:

```bash
cd examples/focus-grove/android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

See [provenance.json](provenance.json) for the source hashes, original APK hash and validation scope. A rebuild has its own APK hash and debug signing key.
