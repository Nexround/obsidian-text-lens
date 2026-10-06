// Independently implemented under the repository's MIT license.
import Foundation
import Vision
import ImageIO
import CoreGraphics

let helperVersion = "__TEXT_LENS_VERSION__"

struct HelperError: Error {
    let code: String
    let message: String
}

func emit(_ value: [String: Any]) throws {
    var data = try JSONSerialization.data(withJSONObject: value, options: [])
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
}

func supportedLanguages() throws -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    if #available(macOS 13.0, *) {
        return try request.supportedRecognitionLanguages()
    }
    return try VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: request.revision)
}

func preferredLanguage(_ supported: [String]) -> String? {
    for preferred in Locale.preferredLanguages {
        let normalized = preferred.lowercased().replacingOccurrences(of: "_", with: "-")
        if let exact = supported.first(where: { $0.lowercased() == normalized }) { return exact }
        let parts = normalized.split(separator: "-")
        // Keep an explicit script (e.g. zh-Hans) when matching a regional tag.
        let prefix = parts.prefix(parts.count > 1 && parts[1].count == 4 ? 2 : 1).joined(separator: "-")
        if let match = supported.first(where: { $0.lowercased() == prefix || $0.lowercased().hasPrefix(prefix + "-") }) { return match }
    }
    return supported.first(where: { $0 == "en-US" }) ?? supported.first(where: { $0.hasPrefix("en-") || $0 == "en" })
}

func canDetectLanguage() -> Bool {
    if #available(macOS 13.0, *) { return true }
    return false
}

struct TextBox {
    let text: String
    let rect: CGRect
}

// Single-column reading order: group nearby vertical centers, then sort each row by x.
func readingOrder(_ observations: [VNRecognizedTextObservation]) -> [String] {
    let boxes = observations.compactMap { observation -> TextBox? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : TextBox(text: text, rect: observation.boundingBox)
    }.sorted { $0.rect.midY > $1.rect.midY }
    var rows: [[TextBox]] = []
    for box in boxes {
        if let last = rows.last, let anchor = last.first,
           abs(anchor.rect.midY - box.rect.midY) <= min(anchor.rect.height, box.rect.height) * 0.5 {
            rows[rows.count - 1].append(box)
        } else { rows.append([box]) }
    }
    return rows.map { row in row.sorted { $0.rect.minX < $1.rect.minX }.map { $0.text }.joined(separator: " ") }
}

func recognize(path: String, language: String, supported: [String], defaultLanguage: String?) throws -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if language == "auto" {
        if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
        else if let fallback = defaultLanguage { request.recognitionLanguages = [fallback] }
        else { throw HelperError(code: "language", message: "No supported preferred language or English recognizer is available") }
    } else {
        guard supported.contains(language) else { throw HelperError(code: "language", message: "OCR language unavailable: \(language)") }
        request.recognitionLanguages = [language]
    }
    // Decode only frame zero, and pass its EXIF orientation to Vision.
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw HelperError(code: "decode", message: "Image could not be decoded by ImageIO")
    }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
    let rawOrientation = (properties?[kCGImagePropertyOrientation as String] as? NSNumber)?.uint32Value ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    try handler.perform([request])
    return readingOrder(request.results ?? [])
}

do {
    let supported = try supportedLanguages()
    let fallback = preferredLanguage(supported)
    while let line = readLine(strippingNewline: true) {
        try autoreleasepool {
            guard let data = line.data(using: .utf8),
                  let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let kind = request["kind"] as? String else {
                throw HelperError(code: "protocol", message: "Invalid JSONL request")
            }
            if kind == "info" {
                try emit(["kind": "info", "version": helperVersion, "languages": supported,
                          "defaultLanguage": fallback.map { $0 as Any } ?? NSNull(),
                          "autoDetection": canDetectLanguage(), "maxImageDimension": NSNull()])
                return
            }
            guard kind == "recognize", let index = request["index"] as? Int,
                  let path = request["path"] as? String, let language = request["language"] as? String else {
                throw HelperError(code: "protocol", message: "Invalid recognition request")
            }
            do {
                let lines = try recognize(path: path, language: language, supported: supported, defaultLanguage: fallback)
                try emit(["kind": "result", "index": index, "ok": true, "lines": lines, "resized": false])
            } catch {
                let failure = error as? HelperError
                try emit(["kind": "result", "index": index, "ok": false,
                          "error": failure?.message ?? error.localizedDescription, "code": failure?.code ?? "recognize"])
            }
        }
    }
} catch {
    FileHandle.standardError.write(Data((String(describing: error) + "\n").utf8))
    exit(1)
}
