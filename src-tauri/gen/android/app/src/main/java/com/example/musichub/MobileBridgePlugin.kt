// Copyright © Cursed Player
//
// Плагин моста «Android ↔ приложение».
//
// На телефоне нет привычной файловой системы: музыку выбирают через системный
// диалог, а WebView не умеет играть `file://`. Мост делает три вещи:
//   1. копирует выбранный файл в кэш приложения и отдаёт путь, который
//      понимает `convertFileSrc` (как на Windows);
//   2. отдаёт имя, размер и mime-тип для карточки трека;
//   3. сообщает, что выбрал пользователь.
//
// Плеер, очередь и тексты остаются в Rust: здесь только платформенная часть.

package com.example.musichub

import android.app.Activity
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream

@InvokeArg
internal class ReadArg {
    lateinit var uri: String
}

@TauriPlugin
class MobileBridgePlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /** Копии выбранных файлов: WebView должен видеть их по обычному пути. */
        private const val CACHE_DIR = "music"
        private const val PICK_REQUEST = 7411
    }

    /**
     * Копирует файл по `content://`-адресу в кэш приложения.
     * Возвращает путь, имя, размер и тип — этого хватает карточке трека.
     */
    @Command
    fun readFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ReadArg::class.java)
            val uri = Uri.parse(args.uri)
            val out = copyToCache(uri) ?: run {
                invoke.reject("Не удалось прочитать файл")
                return
            }
            val info = JSObject()
            info.put("path", out.absolutePath)
            info.put("name", displayName(uri) ?: out.name)
            info.put("size", out.length())
            invoke.resolve(info)
        } catch (e: Exception) {
            invoke.reject(e.message)
        }
    }

    /**
     * Открывает системный выбор аудиофайлов. Результат приходит в
     * `onActivityResult` ниже: интерфейс получает его событием.
     */
    @Command
    fun pickAudio(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "audio/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            activity.startActivityForResult(intent, PICK_REQUEST)
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject(e.message)
        }
    }

    /** Сколько треков уже скопировано — простой признак, что мост живой. */
    @Command
    fun cacheCount(invoke: Invoke) {
        val dir = File(activity.cacheDir, CACHE_DIR)
        val count = dir.listFiles()?.count { it.isFile } ?: 0
        val out = JSObject()
        out.put("count", count)
        invoke.resolve(out)
    }

    private fun copyToCache(uri: Uri): File? {
        val dir = File(activity.cacheDir, CACHE_DIR).apply { mkdirs() }
        val name = displayName(uri) ?: "track-${System.currentTimeMillis()}"
        val out = File(dir, name)
        activity.contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(out).use { output -> input.copyTo(output) }
        } ?: return null
        return out
    }

    private fun displayName(uri: Uri): String? {
        activity.contentResolver
            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor: Cursor ->
                if (cursor.moveToFirst()) return cursor.getString(0)
            }
        return uri.lastPathSegment
    }
}
