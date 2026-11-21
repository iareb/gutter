package io.github.iareb.gutter.documents

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class PickArgs {
    /** "open" for ACTION_OPEN_DOCUMENT, "get" for ACTION_GET_CONTENT (what the dialog plugin uses). */
    var action: String? = null
    var multiple: Boolean = false
}

@InvokeArg
class UriArgs {
    lateinit var uri: String
}

private fun failure(e: Throwable) = e.javaClass.simpleName + ": " + (e.message ?: "")

@TauriPlugin
class DocumentsPlugin(private val activity: Activity) : Plugin(activity) {
    private val resolver get() = activity.contentResolver

    @Command
    fun pickFiles(invoke: Invoke) {
        val args = invoke.parseArgs(PickArgs::class.java)
        val intent = Intent(if (args.action == "get") Intent.ACTION_GET_CONTENT else Intent.ACTION_OPEN_DOCUMENT)
        intent.addCategory(Intent.CATEGORY_OPENABLE)
        intent.type = "*/*"
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
        startActivityForResult(invoke, intent, "filesPicked")
    }

    @ActivityCallback
    fun filesPicked(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            invoke.reject("cancelled")
            return
        }
        val uris = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
        } else {
            data.data?.let { uris.add(it) }
        }
        val files = JSArray()
        for (uri in uris) {
            val file = describeUri(uri)
            file.put("persistable", data.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0)
            file.put("persisted", persist(uri))
            files.put(file)
        }
        val res = JSObject()
        res.put("files", files)
        invoke.resolve(res)
    }

    @Command
    fun pickFolder(invoke: Invoke) {
        startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "folderPicked")
    }

    @ActivityCallback
    fun folderPicked(invoke: Invoke, result: ActivityResult) {
        val tree = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || tree == null) {
            invoke.reject("cancelled")
            return
        }
        val res = describeUri(DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)))
        res.put("uri", tree.toString())
        res.put("persisted", persist(tree))
        invoke.resolve(res)
    }

    @Command
    fun listFolder(invoke: Invoke) {
        val tree = Uri.parse(invoke.parseArgs(UriArgs::class.java).uri)
        val started = System.nanoTime()
        val files = JSArray()
        var folders = 0
        try {
            val pending = ArrayDeque<Pair<String, String>>()
            pending.addLast(DocumentsContract.getTreeDocumentId(tree) to "")
            val columns = arrayOf(
                Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
                Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED
            )
            while (pending.isNotEmpty()) {
                val (id, path) = pending.removeFirst()
                val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
                resolver.query(children, columns, null, null, null)?.use { c ->
                    while (c.moveToNext()) {
                        val childId = c.getString(0)
                        val name = c.getString(1)
                        if (c.getString(2) == Document.MIME_TYPE_DIR) {
                            folders++
                            pending.addLast(childId to "$path$name/")
                        } else {
                            val file = JSObject()
                            file.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, childId).toString())
                            file.put("path", path + name)
                            file.put("mime", c.getString(2))
                            file.put("size", c.getLong(3))
                            file.put("modified", c.getLong(4))
                            files.put(file)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            invoke.reject(failure(e))
            return
        }
        val res = JSObject()
        res.put("files", files)
        res.put("folders", folders)
        res.put("ms", (System.nanoTime() - started) / 1_000_000)
        invoke.resolve(res)
    }

    @Command
    fun describe(invoke: Invoke) {
        invoke.resolve(describeUri(Uri.parse(invoke.parseArgs(UriArgs::class.java).uri)))
    }

    @Command
    fun held(invoke: Invoke) {
        val list = JSArray()
        for (p in resolver.persistedUriPermissions) {
            val item = JSObject()
            item.put("uri", p.uri.toString())
            item.put("read", p.isReadPermission)
            item.put("time", p.persistedTime)
            list.put(item)
        }
        val res = JSObject()
        res.put("held", list)
        invoke.resolve(res)
    }

    @Command
    fun release(invoke: Invoke) {
        val uri = Uri.parse(invoke.parseArgs(UriArgs::class.java).uri)
        val res = JSObject()
        try {
            resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            res.put("released", true)
        } catch (e: Exception) {
            res.put("released", false)
            res.put("error", failure(e))
        }
        invoke.resolve(res)
    }

    private fun persist(uri: Uri): String = try {
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        "yes"
    } catch (e: Exception) {
        failure(e)
    }

    /** The file's name and size as the system gives them, and whether it opens now. */
    private fun describeUri(uri: Uri): JSObject {
        val res = JSObject()
        res.put("uri", uri.toString())
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    res.put("name", c.getString(0))
                    if (!c.isNull(1)) res.put("size", c.getLong(1))
                }
            }
        } catch (e: Exception) {
            res.put("queryError", failure(e))
        }
        try {
            resolver.openFileDescriptor(uri, "r")?.use { res.put("readable", true) }
        } catch (e: Exception) {
            res.put("readable", false)
            res.put("openError", failure(e))
        }
        return res
    }
}
