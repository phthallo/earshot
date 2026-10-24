package com.venuemap.locator

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class Person(val personId: Int, val displayName: String, val team: String, val color: String) {
    fun toJson(): String = JSONObject()
        .put("personId", personId)
        .put("displayName", displayName)
        .put("team", team)
        .put("color", color)
        .toString()

    companion object {
        fun fromJson(text: String): Person = JSONObject(text).let {
            Person(
                it.getInt("personId"),
                it.getString("displayName"),
                it.optString("team", ""),
                it.optString("color", "#888888"),
            )
        }
    }
}

data class Zone(val zoneId: String, val name: String, val floor: Int, val samples: Int)
data class Scan(val bssid: String, val rssi: Int)
data class Location(val zoneId: String, val confidence: Double, val distance: Double)

class ApiException(message: String) : Exception(message)

object Api {
    fun login(base: String, pairCode: String): Person =
        Person.fromJson(request(base, "POST", "/api/fp/login", JSONObject().put("pairCode", pairCode)))

    fun zones(base: String): List<Zone> {
        val arr = JSONArray(request(base, "GET", "/api/fp/zones", null))
        return (0 until arr.length()).map { arr.getJSONObject(it) }.map {
            Zone(it.getString("zoneId"), it.getString("name"), it.optInt("floor", 1), it.optInt("samples", 0))
        }
    }

    fun learn(base: String, zoneId: String, scans: List<Scan>): Int {
        val body = JSONObject().put("zoneId", zoneId).put("scans", scansJson(scans))
        return JSONObject(request(base, "POST", "/api/fp/learn", body)).optInt("samples", 0)
    }

    fun locate(base: String, pairCode: String, scans: List<Scan>): Location {
        val body = JSONObject().put("pairCode", pairCode).put("scans", scansJson(scans))
        return JSONObject(request(base, "POST", "/api/fp/locate", body)).let {
            Location(it.getString("zoneId"), it.optDouble("confidence", 0.0), it.optDouble("distance", 0.0))
        }
    }

    fun forget(base: String, zoneId: String) {
        request(base, "POST", "/api/fp/forget", JSONObject().put("zoneId", zoneId))
    }

    private fun scansJson(scans: List<Scan>): JSONArray = JSONArray().also { arr ->
        scans.forEach { arr.put(JSONObject().put("bssid", it.bssid).put("rssi", it.rssi)) }
    }

    private fun request(base: String, method: String, path: String, body: JSONObject?): String {
        val conn = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 5_000
            conn.readTimeout = 10_000
            conn.setRequestProperty("Accept", "application/json")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = conn.responseCode
            val stream = if (code < 400) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code >= 400) {
                val message = try { JSONObject(text).optString("error", "") } catch (e: Exception) { "" }
                throw ApiException(message.ifEmpty { "Server returned $code" })
            }
            return text
        } finally {
            conn.disconnect()
        }
    }
}
