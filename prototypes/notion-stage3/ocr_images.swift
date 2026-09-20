// Local Apple Vision OCR for explicitly selected archived images. Experiment only.
import Foundation
import Vision
import ImageIO

struct Job: Codable { let id: String; let image: String; let ordinal: Int }
struct Line: Codable { let text: String; let confidence: Float; let x: Double; let y: Double; let width: Double; let height: Double }
struct Result: Codable { let id: String; let ordinal: Int; let engine: String; let status: String; let lines: [Line]; let error: String? }

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: ocr_images jobs.json\n", stderr)
    exit(2)
}
let jobs = try JSONDecoder().decode([Job].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
for job in jobs {
    let result: Result
    do {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(url: URL(fileURLWithPath: job.image), options: [:])
        try handler.perform([request])
        let lines = (request.results ?? []).compactMap { observation -> Line? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return Line(text: candidate.string, confidence: candidate.confidence, x: box.origin.x, y: box.origin.y, width: box.width, height: box.height)
        }
        result = Result(id: job.id, ordinal: job.ordinal, engine: "Apple Vision VNRecognizeTextRequest", status: "processed", lines: lines, error: nil)
    } catch {
        let failure = error as NSError
        result = Result(id: job.id, ordinal: job.ordinal, engine: "Apple Vision VNRecognizeTextRequest", status: "failed", lines: [], error: "\(failure.domain) code \(failure.code); original file unchanged")
    }
    print(String(data: try encoder.encode(result), encoding: .utf8)!)
}
