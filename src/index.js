require("dotenv").config();

const express = require("express");
const fs = require("fs");
const multer = require("multer");
const path = require("path");

const { uploadInputImage, uploadVariant } = require("./cloudinary");
const {
  uploadImageToFilesApi,
  submitBatchJob,
  getBatchStatus,
  extractDescriptions,
  generateAllVariants,
  BATCH_MODEL,
  IMAGE_GEN_MODEL,
  FREE_IMAGE_MODELS,
} = require("./gemini");

const PORT = process.env.PORT || 3000;
const VARIANT_COUNT = parseInt(process.env.VARIANT_COUNT || "50", 10);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const JOBS_DIR = path.join(process.cwd(), "jobs");
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const FAILED_STATES = [
  "JOB_STATE_FAILED",
  "FAILED",
  "JOB_STATE_CANCELLED",
  "CANCELLED",
];
const SUCCEEDED_STATES = ["JOB_STATE_SUCCEEDED", "SUCCEEDED"];

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Invalid file type "${file.mimetype}". Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
        ),
      );
    }
  },
});

function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

function getJobFilePath(batchName) {
  return path.join(JOBS_DIR, `${encodeURIComponent(batchName)}.json`);
}

function serializeJob(data) {
  const serialized = { ...data };

  if (Buffer.isBuffer(serialized.imageBuffer)) {
    serialized.imageBufferBase64 = serialized.imageBuffer.toString("base64");
    delete serialized.imageBuffer;
  }

  return serialized;
}

function hydrateJob(data) {
  if (!data) return null;

  const hydrated = { ...data };

  if (hydrated.imageBufferBase64) {
    hydrated.imageBuffer = Buffer.from(hydrated.imageBufferBase64, "base64");
  }

  return hydrated;
}

function writeJob(batchName, data) {
  ensureJobsDir();
  const payload = serializeJob({ ...data, batchName });
  fs.writeFileSync(
    getJobFilePath(batchName),
    JSON.stringify(payload, null, 2),
  );
  return hydrateJob(payload);
}

function readJob(batchName) {
  try {
    const data = JSON.parse(fs.readFileSync(getJobFilePath(batchName), "utf8"));
    return hydrateJob(data);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function buildResultPayload(batchName, job, cached, skipUpload = false) {
  const descriptions = extractDescriptions(job);
  console.log(`Extracted ${descriptions.length} descriptions from batch`);

  const { imageBuffer, mimeType, inputImageUrl } = cached;

  const variantResults = await generateAllVariants(
    descriptions,
    imageBuffer,
    mimeType,
  );

  const batchIdShort = batchName.split("/").pop();
  const imageLinks = [];
  const errors = [];

  if (!skipUpload) {
    const uploadPromises = variantResults.map((v) => {
      if (v.error) {
        errors.push({ variantId: `variant_${v.index}`, error: v.error });
        return Promise.resolve(null);
      }
      return uploadVariant(v.buffer, batchIdShort, v.index)
        .then((link) => imageLinks.push(link))
        .catch((err) =>
          errors.push({
            variantId: `variant_${v.index}`,
            error: err.message,
          }),
        );
    });
    await Promise.all(uploadPromises);
  } else {
    for (const v of variantResults) {
      if (v.error) {
        errors.push({ variantId: `variant_${v.index}`, error: v.error });
      } else {
        imageLinks.push({
          variantId: `variant_${v.index}`,
          imageUrl: `data:image/jpeg;base64,${v.buffer.toString("base64")}`,
          fileName: null,
        });
      }
    }
  }

  return {
    batchName,
    state: job.state ?? "UNKNOWN",
    inputImageUrl,
    totalVariants: imageLinks.length,
    failedVariants: errors.length,
    imageLinks,
    errors: errors.length > 0 ? errors : undefined,
    message:
      imageLinks.length > 0
        ? `${imageLinks.length} variants generated successfully.`
        : "No variants could be generated.",
  };
}

app.post("/generate", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    const variantCount = Math.min(
      parseInt(req.body?.count || VARIANT_COUNT, 10) || VARIANT_COUNT,
      50,
    );

    const mimeType = req.file.mimetype;

    const inputImageUrl = await uploadInputImage(req.file.buffer);
    console.log(`Packshot archived: ${inputImageUrl}`);
    const fileUri = await uploadImageToFilesApi(req.file.buffer, mimeType);

    const batchJob = await submitBatchJob(fileUri, variantCount);
    const cached = writeJob(batchJob.name, {
      imageBuffer: req.file.buffer,
      mimeType,
      inputImageUrl,
      variantCount,
      state: batchJob.state,
      status: "QUEUED",
      message: "Batch job submitted. Poll GET /results/:batchName for status.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return res.status(202).json({
      batchName: batchJob.name,
      state: batchJob.state,
      status: cached.status,
      variantCount,
      inputImageUrl,
      message: `Batch job submitted with ${variantCount} variant requests. Poll GET /results/${batchJob.name}.`,
    });
  } catch (err) {
    console.error("[/generate] Error:", err.message);
    return res.status(500).json({
      error: "Failed to submit batch job",
      message: err.message,
    });
  }
});

app.get("/results/:batchName(*)", async (req, res) => {
  try {
    const batchName = req.params.batchName;
    let cached = readJob(batchName);

    if (cached?.result) {
      return res.json(cached.result);
    }

    const job = await getBatchStatus(batchName);
    const state = job.state ?? "UNKNOWN";

    if (FAILED_STATES.includes(state)) {
      if (cached) {
        cached = writeJob(batchName, {
          ...cached,
          state,
          status: "FAILED",
          error: `Batch job ended with state: ${state}`,
          updatedAt: new Date().toISOString(),
        });
      }

      return res.status(422).json({
        batchName,
        state,
        error: `Batch job ended with state: ${state}`,
      });
    }

    if (!SUCCEEDED_STATES.includes(state)) {
      if (cached) {
        cached = writeJob(batchName, {
          ...cached,
          state,
          status: "PROCESSING",
          message: "Batch job is still processing. Please poll again later.",
          updatedAt: new Date().toISOString(),
        });
      }

      return res.status(202).json({
        batchName,
        state,
        status: cached?.status ?? "PROCESSING",
        message: "Batch job is still processing. Please poll again later.",
        completionStats: job.completionStats ?? null,
        inputImageUrl: cached?.inputImageUrl,
        updatedAt: cached?.updatedAt,
      });
    }

    if (!cached) {
      return res.status(410).json({
        error: "Session expired",
        message:
          "The server was restarted after this batch was submitted. " +
          "Please re-submit via POST /generate.",
      });
    }

    const skipUpload = req.query.upload === "false";
    const result = await buildResultPayload(batchName, job, cached, skipUpload);
    cached = writeJob(batchName, {
      ...cached,
      result,
      state,
      status: "COMPLETED",
      message: result.message,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return res.json(cached.result);
  } catch (err) {
    console.error("[/results] Error:", err.message);
    return res.status(500).json({
      error: "Failed to retrieve batch results",
      message: err.message,
    });
  }
});

app.get("/health", (_req, res) =>
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    variantCount: VARIANT_COUNT,
    models: {
      batch: BATCH_MODEL,
      imageGen: IMAGE_GEN_MODEL,
      supportedFreeImageModels: FREE_IMAGE_MODELS,
    },
    jobsDir: JOBS_DIR,
  }),
);

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      error: "File too large",
      message: `Maximum file size is ${MAX_FILE_SIZE / 1024 / 1024} MB`,
    });
  }
  if (err?.message?.includes("Invalid file type")) {
    return res
      .status(400)
      .json({ error: "Invalid file type", message: err.message });
  }
  console.error("[Unhandled]", err);
  return res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(
    `Server: http://localhost:${PORT} || Variants: ${VARIANT_COUNT} per batch`,
  );
});

module.exports = app;
