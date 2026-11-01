# Development setup

How to get gutter running from a fresh machine. Desktop needs the common tools plus the section for your OS; Android needs a desktop setup first.

Versions below are the ones the project is developed with. Newer ones usually work.

## Common tools

| Tool | Version | Notes |
| --- | --- | --- |
| Git | any recent | |
| Rust | stable, via [rustup](https://rustup.rs) | 1.97 at the time of writing |
| Node.js | LTS (22 or later) | |
| pnpm | 11 | Enabled through Node's corepack: `corepack enable pnpm` |

Then, from the repo root:

```sh
pnpm install
pnpm tauri dev
```

The first run compiles all Rust dependencies and takes a few minutes; later runs only rebuild what changed. A dark window titled gutter means everything works.

## Windows

1. **Microsoft C++ Build Tools:** install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload. Rust needs its linker.
2. **WebView2:** already part of Windows 10 and 11. Nothing to do.
3. **Rust:** run `rustup-init.exe` from [rustup.rs](https://rustup.rs) and accept the defaults (`x86_64-pc-windows-msvc`).
4. **Node.js:** the LTS installer from [nodejs.org](https://nodejs.org), then `corepack enable pnpm` in a terminal opened as administrator.

Any terminal works. In Git Bash, prefix commands that take Android paths (`adb shell /sdcard/...`) with `MSYS_NO_PATHCONV=1`, otherwise Git Bash rewrites them as Windows paths.

## Linux

Tauri uses WebKitGTK, so the system needs its development libraries.

**Debian, Ubuntu and derivatives:**

```sh
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Fedora:**

```sh
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"
```

**Arch:**

```sh
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

The [Tauri prerequisites page](https://v2.tauri.app/start/prerequisites/#linux) lists other distributions.

Then Rust and Node, as a normal user (reopen the terminal after each installer so the new commands are found):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install --lts
corepack enable pnpm
```

### Linux inside WSL (Windows)

WSL 2 on Windows 11 runs gutter with WSLg, which shows Linux windows on the Windows desktop. Useful to test WebKitGTK without a Linux machine. Follow the Linux steps inside the distribution, plus:

- **Clone inside the Linux home** (`~/gutter`), not under `/mnt/c`: Windows files seen from Linux are slow, and `node_modules` differs between the two systems.
- **Use Linux's own Node and pnpm.** The Windows ones are on the WSL `PATH` too (e.g. `/mnt/c/.../npm/pnpm`); `command -v pnpm` must print a Linux path.
- Windows files are under `/mnt/c/...`, handy to open test files from the Windows side.
- Input arrives through Windows: the trackpad behaves like a mouse, so gesture tests need real Linux.

## Android

Needs a working desktop setup first. Tested on Windows; the same steps apply on Linux and macOS with their own paths.

### Tools

1. **[Android Studio](https://developer.android.com/studio).** Then open *Settings → Languages & Frameworks → Android SDK* and install:
   - *SDK Platforms:* the latest Android version;
   - *SDK Tools:* Android SDK Build-Tools, Android SDK Command-line Tools, Android SDK Platform-Tools, and **NDK (Side by side) 29.0.14206865**.
2. **A JDK, 17 or later.** Android Studio's bundled one works (`<Android Studio>/jbr`); the project uses Eclipse Temurin 21.
3. **Environment variables** (on Windows: *System → Environment variables*, user section):

   | Variable | Example on Windows |
   | --- | --- |
   | `JAVA_HOME` | `C:\Program Files\Eclipse Adoptium\jdk-21.0.3.9-hotspot` |
   | `ANDROID_HOME` | `C:\Users\<you>\AppData\Local\Android\Sdk` |
   | `NDK_HOME` | `%ANDROID_HOME%\ndk\29.0.14206865` |

   Optionally add `%ANDROID_HOME%\platform-tools` to `PATH` to run `adb` directly.
4. **Rust targets:**

   ```sh
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```

The Android project is already generated and committed in `src-tauri/gen/android`: do not run `pnpm tauri android init` again.

### Connecting a phone

1. On the phone: *Settings → About phone*, tap *Build number* 7 times to unlock *Developer options*.
2. **Over USB:** enable *USB debugging*, plug the phone in and accept the prompt on the phone. If no prompt appears, try another cable or port: some USB-C cables only charge.
3. **Over Wi-Fi** (phone and PC on the same network): enable *Wireless debugging*, open it and choose *Pair device with pairing code*, then on the PC:

   ```sh
   adb pair <ip>:<pairing port>      # asks for the 6-digit code
   adb connect <ip>:<port>           # the port shown on the main Wireless debugging screen
   ```

   Pairing is done once. The connection port changes every time wireless debugging is turned on, and the phone turns it off after a reboot or a network change. A paired phone often reconnects on its own when wireless debugging is turned back on.
4. `adb devices` must list the phone as `device`.

### Running

```sh
pnpm tauri android dev
```

This builds the app, installs it on the phone and loads the UI from the dev server on the PC, so edits show up live. Things that look like bugs but are not:

- **The app closes after a second when opened without the PC.** A dev build has no UI of its own; it needs `pnpm tauri android dev` running.
- **No icon on the home screen.** Apps installed through adb are not added automatically; find gutter in the app drawer.
- **The page reloads after picking a file.** While the system picker is open the app is in the background, the dev server connection drops and Vite reloads the page when it reconnects. Development only.
- **The first install over Wi-Fi is slow.** The dev APK is about 150 MB.

To copy a test file to the phone:

```sh
adb push <file> /sdcard/Download/
```

Logs from the app (`console.log` in the UI shows up as `Tauri/Console`):

```sh
adb logcat -s Tauri/Console
```

## Test files

Copyrighted comics cannot go in the repo. `pnpm corpus` generates synthetic test volumes in `corpus/generated/` (about 130 MB); [corpus/README.md](../corpus/README.md) explains each one and where to put real comics.
