import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2] ?? "success";
const workerMode = process.argv.at(-1);

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (workerMode === "--health") {
  if (mode === "noise") {
    process.stdout.write("not-json\nsecond-line\n");
  } else {
    line({
      protocolVersion: 1,
      status: "ok",
      worker: "fake-compute-worker",
      pythonVersion: "3.12.0",
      implementedOperations: ["extract_pdf", "extract_workbook"],
      contractOperations: ["extract_pdf", "extract_workbook"],
      capabilities: {
        extract_document: {
          extensions: [".csv", ".docx", ".markdown", ".md", ".pptx", ".txt"],
          recordsMediaType: "application/x-ndjson",
          boundedExtraction: true,
        },
        fetch_market_data: {
          providers: ["fixture", "akshare"],
          akshareOptional: true,
        },
      },
      dependencies: { pymupdf: true, openpyxl: true },
    });
  }
} else if (mode === "hang") {
  setInterval(() => {}, 60_000);
} else {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const request = JSON.parse(input);
  if (mode === "noise") {
    process.stdout.write("debug output\n");
    line({ any: "record" });
  } else if (mode === "mismatch") {
    line({
      protocolVersion: 1,
      requestId: "different-request",
      status: "failed",
      recordsFile: null,
      artifacts: [],
      metrics: { errorCode: "unsupported_operation" },
      error: "unsupported",
    });
  } else if (mode === "failed") {
    line({
      protocolVersion: 1,
      requestId: request.requestId,
      status: "failed",
      recordsFile: null,
      artifacts: [],
      metrics: { errorCode: "unsupported_operation" },
      error: "Unsupported compute operation",
    });
  } else {
    await mkdir(request.outputDirectory, { recursive: true });
    const relative = "records.ndjson";
    const content = '{"recordType":"fixture"}\n';
    await writeFile(path.join(request.outputDirectory, relative), content, "utf8");
    const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    line({
      protocolVersion: 1,
      requestId: request.requestId,
      status: "completed",
      recordsFile: relative,
      artifacts: [
        {
          path: relative,
          mediaType: "application/x-ndjson",
          checksum:
            mode === "bad-checksum"
              ? "sha256:0000000000000000000000000000000000000000000000000000000000000000"
              : checksum,
          size: Buffer.byteLength(content),
        },
      ],
      metrics: { recordCount: 1 },
      error: null,
    });
  }
}
