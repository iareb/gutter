# Spike `android-library` — Files that stay readable on Android

**Question:** can a library on Android keep the files the reader chose and open them again after the app is closed and the phone restarted? And can it be given a whole folder, list what is in it, and tell a file that went away?

**Answer: yes, with a small plugin of our own.** The dialog plugin asks Android for a file with `ACTION_GET_CONTENT`, and an address got that way stops working as soon as the app is closed: it cannot be the address of a volume in a library. Asking with `ACTION_OPEN_DOCUMENT` and keeping the permission the system grants (`takePersistableUriPermission`) gives an address that opens again after the app is closed and after the phone restarts, from the Rust side as it is (the fs plugin's file descriptor). A folder chosen with `ACTION_OPEN_DOCUMENT_TREE` gives the same for everything inside it, subfolders included, with no limit on the number of files; the system will not give the root of the storage or `Download` itself, only a folder inside them. The real file name comes from the system, which ends the "Comic" in the bar.

Date: 2026-11-21 · Code: `src-tauri/plugins/documents` (kept: it is the base of steps 4.3 and 4.6); the script that drove the phone is a scratch tool, its steps are below

## Setup

| | |
| --- | --- |
| Phone | Motorola edge 60, Android 17 |
| Build | debug APK (`pnpm tauri android build --debug --apk --target aarch64`), installed over the previous one |
| Files | a folder made for the spike, `Download/gutter-spike`, with copies of corpus files: `spike-a.cbz`, `spike-del.cbz`, `spike-rename.cbz`, `notes.txt`, `sub/spike-b.cbr`, `sub/deeper/spike-c.cbz` |
| Driving | the app through its DevTools (calls to the commands), the system picker with real taps through `adb shell input`, found in the screen dump of `uiautomator` |

The plugin has six commands: `pick_files` (with `action: "open"` for `ACTION_OPEN_DOCUMENT` or `"get"` for `ACTION_GET_CONTENT`, as the dialog plugin does, to compare the two), `pick_folder`, `list_folder` (every file under a folder, walked breadth first), `describe` (name and size as the system gives them, and whether the file opens now), `held` (the permissions the app keeps) and `release`. Each picked address was then opened twice: by the plugin (`openFileDescriptor`) and by the Rust side through `open_volume`, exactly as a volume is opened today.

## Results

**Picking.** Through the picker's search box, a tap on the result:

| Picked with | Picker offers a lasting permission | `takePersistableUriPermission` |
| --- | --- | --- |
| `ACTION_OPEN_DOCUMENT`, one file | yes | kept |
| `ACTION_OPEN_DOCUMENT`, two files at once (long press, a tap, "Select") | yes, for each | kept, for each |
| `ACTION_GET_CONTENT` (the dialog plugin's way) | no | refused: `SecurityException: No persistable permission grants found` |
| `ACTION_OPEN_DOCUMENT_TREE`, the folder `gutter-spike` | yes, after the system asks "Allow Gutter to access the folder?" | kept |

Every file arrives with its name (`spike-a.cbz`) and size. Files come from the Downloads provider (`content://com.android.providers.downloads.documents/document/raw%3A…`, an address built on the path); files under a folder come from the storage provider (`content://com.android.externalstorage.documents/tree/primary%3ADownload%2Fgutter-spike/document/primary%3A…%2Fsub%2Fspike-b.cbr`). The folder picker refuses the root of the storage and `Download` ("To protect your privacy, choose another folder"); a folder inside `Download` is fine.

**Opening again**, by the plugin and by Rust, which always agreed:

| Address | App running | App closed (`am force-stop`) and opened again | Phone restarted |
| --- | --- | --- | --- |
| Picked with `ACTION_OPEN_DOCUMENT` | opens | opens | opens |
| Picked with `ACTION_GET_CONTENT` or the dialog plugin | opens | `Permission Denial … requires that you obtain access using ACTION_OPEN_DOCUMENT` | the same |
| A file under the picked folder (5 files, 3 levels) | opens | opens | opens |

So today's app, which opens files through the dialog plugin, could not reopen a single volume of a library after a restart.

**Files that went away.** With the app running, outside the app (`adb shell`): `spike-del.cbz` deleted, `spike-rename.cbz` renamed to `spike-renamed.cbz`, a new `sub/spike-new.cbz` copied in.

- **Picked as single files:** both addresses fail with `Permission Denial`, the same error as a permission never kept, and both permissions are gone from the list the app keeps (`held`): the system drops them when the file is deleted or renamed. A missing file and a lost permission cannot be told apart, and a renamed file has to be picked again.
- **Under the picked folder:** the old addresses fail with `FileNotFoundException: Missing file for primary:Download/gutter-spike/spike-del.cbz`, which says exactly what happened. Listing the folder again shows `spike-renamed.cbz` and `sub/spike-new.cbz`, and both open; the folder's permission stays.

**Listing a folder** (inside the plugin, from the first query to the last row, three runs each):

| Folder | Time |
| --- | --- |
| The spike folder: 6 files in 3 folders | 35–134 ms |
| 400 files in one folder | 774–798 ms |
| 400 files in 20 subfolders | 1.7–2.4 s |

About 2 ms a file and 70 ms a folder on this phone: a folder of a few hundred volumes lists in a second or two, so listing goes in the background, never in the way of reading.

## What was not tried

- A memory card, and providers other than the phone's storage (Google Drive, other apps' documents): the picker offers them, but whether their addresses keep working, and how fast a page reads from them, is not known.
- The limit on lasting permissions: Android documents it as 512 per app since Android 11 (128 before). A folder counts as one, whatever is inside it; single files count one each.
- Android versions before 17 on a real phone (the APIs used exist since Android 5; Gutter needs Android 7).

## Decision

1. **Files are picked with `ACTION_OPEN_DOCUMENT` and their permission is kept**, through the plugin in `src-tauri/plugins/documents`. On Android the "Open" button and "Add" in the library use it (steps 4.3 and 4.6); on a computer the dialog plugin stays, since paths do not expire. When a volume is removed from the library, its permission is given back (`release`).
2. **Folders are the way to add many volumes on Android.** "Add folder" uses `ACTION_OPEN_DOCUMENT_TREE`; the library stores the folder and, for each volume in it, the address under the folder. The library tells the reader that `Download` itself cannot be chosen and suggests a folder inside it (for example `Download/Fumetti`). A folder costs one permission whatever it holds, so the 512 limit only matters for volumes added one by one.
3. **A folder is listed again in the background** when the library opens: new volumes are added, renamed ones are found again by their fingerprint (4.2) and keep their place, deleted ones show as missing. This is the "watching" that the desktop does not have in M4, and on Android it costs a second or two for a few hundred volumes.
4. **A volume is missing** (step 4.7) when its file does not open: under a folder the error says the file is missing; for a single file, the permission has disappeared from the list the app keeps, and the two cases are the same to the reader (pick it again, or remove it).
5. **The name shown is the system's name for the file** (`describe`), so the bar on Android says the file name instead of "Comic"; this lands with step 4.3, when the Open button moves to the plugin.

## To repeat it

The plugin is in the app; from the app's DevTools on the phone (`adb forward tcp:9224 localabstract:webview_devtools_remote_<pid>`):

```js
const call = window.__TAURI_INTERNALS__.invoke
await call('plugin:documents|pick_files', { args: { action: 'open', multiple: true } }) // then pick in the picker
await call('plugin:documents|pick_folder') // then a folder inside Download, "Use this folder", "Allow"
await call('plugin:documents|list_folder', { uri: '<the folder address>' })
await call('open_volume', { path: '<a file address>' }) // after `adb shell am force-stop io.github.iareb.gutter`, or a restart
await call('plugin:documents|held')
```
