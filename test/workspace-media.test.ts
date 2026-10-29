import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";

const helper = process.env.VAK_TEST_SANDBOX_BIN ?? path.resolve("../sandbox/target/debug/vaksb");
const native = process.platform === "darwin" && existsSync(helper);

// Minimal valid 1x1 transparent PNG binary bytes
const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, // IDAT
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND
  0x42, 0x60, 0x82,
]);

// Minimal valid WAV header
const VALID_WAV_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x24, 0x00, 0x00, 0x00, // file size - 8
  0x57, 0x41, 0x56, 0x45, // "WAVE"
  0x66, 0x6d, 0x74, 0x20, // "fmt "
  0x10, 0x00, 0x00, 0x00, // 16 bytes format chunk
  0x01, 0x00,             // PCM format
  0x01, 0x00,             // 1 channel
  0x44, 0xac, 0x00, 0x00, // 44100 sample rate
  0x88, 0x58, 0x01, 0x00, // byte rate
  0x02, 0x00,             // block align
  0x10, 0x00,             // 16 bits per sample
  0x64, 0x61, 0x74, 0x61, // "data"
  0x00, 0x00, 0x00, 0x00, // data size 0
]);

// Minimal PDF header
const VALID_PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

test("governed export of media asset to workspace and binary review/apply identity", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-ws-media-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-ws-media-proj-"));

  const app = await startAppServer({
    dataDir,
    access: "open",
    sandboxBin: helper,
  });

  const api = async (route: string, method = "GET", value?: unknown) => {
    const res = await app.request(
      new Request(`http://localhost${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
    );
    return { status: res.status, ok: res.ok, body: (await res.json()) as any };
  };

  try {
    // 1. Import a binary PNG into media library via /api/media/import
    const importMedia = await api("/api/media/import", "POST", {
      name: "icon.png",
      data: VALID_PNG_BYTES.toString("base64"),
    });
    assert.equal(importMedia.status, 200);
    const assetId = importMedia.body.id;
    assert.ok(assetId);

    // 2. Bind chat session to projectDir
    const session = "chat-media-1";
    await api(`/api/workspaces/bindings/${session}`, "POST", { folder: projectDir });

    // 3. Export asset to workspace Realm
    const exportRes = await api(`/api/workspaces/bindings/${session}/export-asset`, "POST", {
      assetId,
      targetPath: "assets/logo.png",
    });
    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.body.ok, true);
    assert.equal(exportRes.body.path, "assets/logo.png");
    const expectedHash = createHash("sha256").update(VALID_PNG_BYTES).digest("hex");
    assert.equal(exportRes.body.sha256, expectedHash);

    // Verify original project on disk does NOT yet have the file (isolated realm copy)
    assert.equal(existsSync(path.join(projectDir, "assets", "logo.png")), false);

    // 4. Path traversal in export is rejected
    const travExport = await api(`/api/workspaces/bindings/${session}/export-asset`, "POST", {
      assetId,
      targetPath: "../escape.png",
    });
    assert.equal(travExport.status, 400);

    // 5. Review candidate changes in Realm
    const reviewRes = await api(`/api/workspaces/bindings/${session}/realm/review`);
    assert.equal(reviewRes.status, 200);
    assert.ok(reviewRes.body.total >= 1);
    const change = reviewRes.body.changes.find((c: any) => c.path === "assets/logo.png");
    assert.ok(change);
    assert.equal(change.after.bytes, VALID_PNG_BYTES.length);
    assert.equal(change.after.hash, expectedHash);

    // 6. Apply candidate changes: bit-for-bit identity promoted to original project
    const allPaths = reviewRes.body.changes.map((c: any) => c.path);
    const applyRes = await api(`/api/workspaces/bindings/${session}/realm/apply`, "POST", {
      fingerprint: reviewRes.body.fingerprint,
      paths: allPaths,
    });
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.phase, "committed");

    // Original project on disk now has the exact binary bytes
    const onDiskFile = path.join(projectDir, "assets", "logo.png");
    assert.equal(existsSync(onDiskFile), true);
    const diskBytes = readFileSync(onDiskFile);
    assert.equal(diskBytes.equals(VALID_PNG_BYTES), true);
    assert.equal(createHash("sha256").update(diskBytes).digest("hex"), expectedHash);

    // 7. Rollback / undo restores original clean state
    const undoRes = await api(`/api/workspaces/bindings/${session}/realm/undo`, "POST", {
      transactionId: applyRes.body.transaction_id,
      paths: applyRes.body.paths ?? allPaths,
    });
    assert.equal(undoRes.status, 200);
    assert.equal(existsSync(onDiskFile), false);
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("governed import from workspace to media/attachments with format and resource validation", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-ws-import-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-ws-import-proj-"));

  // Create sample files in projectDir
  writeFileSync(path.join(projectDir, "sample.png"), VALID_PNG_BYTES);
  writeFileSync(path.join(projectDir, "audio.wav"), VALID_WAV_BYTES);
  writeFileSync(path.join(projectDir, "doc.pdf"), VALID_PDF_BYTES);
  writeFileSync(path.join(projectDir, "data.csv"), "item,price\nwidget,10\n");
  writeFileSync(path.join(projectDir, "bad.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));

  const app = await startAppServer({
    dataDir,
    access: "open",
    sandboxBin: helper,
  });

  const api = async (route: string, method = "GET", value?: unknown) => {
    const res = await app.request(
      new Request(`http://localhost${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
    );
    return { status: res.status, ok: res.ok, body: (await res.json()) as any };
  };

  try {
    const session = "chat-import-1";
    await api(`/api/workspaces/bindings/${session}`, "POST", { folder: projectDir });

    // 1. Import PNG image
    const imgRes = await api(`/api/workspaces/bindings/${session}/import-file`, "POST", {
      relativePath: "sample.png",
    });
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.body.format, "image/png");
    assert.equal(imgRes.body.bytes, VALID_PNG_BYTES.length);
    assert.ok(imgRes.body.asset?.id);

    // 2. Import WAV audio
    const wavRes = await api(`/api/workspaces/bindings/${session}/import-file`, "POST", {
      relativePath: "audio.wav",
    });
    assert.equal(wavRes.status, 200);
    assert.equal(wavRes.body.format, "audio/wav");
    assert.equal(wavRes.body.bytes, VALID_WAV_BYTES.length);

    // 3. Import PDF document
    const pdfRes = await api(`/api/workspaces/bindings/${session}/import-file`, "POST", {
      relativePath: "doc.pdf",
    });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.body.format, "application/pdf");
    assert.equal(pdfRes.body.bytes, VALID_PDF_BYTES.length);

    // 4. Import CSV data
    const csvRes = await api(`/api/workspaces/bindings/${session}/import-file`, "POST", {
      relativePath: "data.csv",
    });
    assert.equal(csvRes.status, 200);
    assert.equal(csvRes.body.format, "text/csv");

    // 5. Path traversal attempt is rejected
    const travRes = await api(`/api/workspaces/bindings/${session}/import-file`, "POST", {
      relativePath: "../outside.txt",
    });
    assert.equal(travRes.status, 400);

    // 6. Unsupported binary format is rejected with 415
    const badRes = await api(`/api/workspaces/bindings/${session}/import-file`, "POST", {
      relativePath: "bad.bin",
    });
    assert.equal(badRes.status, 415);
    assert.match(badRes.body.error, /Unsupported file format/i);

    // 7. Non-existent file is rejected with 404
    const nonExistent = await api(`/api/workspaces/bindings/${session}/import-file`, "POST", {
      relativePath: "missing.png",
    });
    assert.equal(nonExistent.status, 404);
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
