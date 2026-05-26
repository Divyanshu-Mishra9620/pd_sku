require("dotenv").config();

const express = require("express");
const multer = require("multer");

const { uploadInputImage, uploadVariant } = require("./cloudinary");
const {
  publishJob,
  consumeJobs,
  closeRabbitMq,
  RABBITMQ_QUEUE,
  RABBITMQ_URL,
  formatRabbitError,
} = require("./rabbitmq");
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
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const MAX_POLL_ATTEMPTS = parseInt(process.env.MAX_POLL_ATTEMPTS || "120", 10);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const FAILED_STATES = [
  "JOB_STATE_FAILED",
  "FAILED",
  "JOB_STATE_CANCELLED",
  "CANCELLED",
];
const SUCCEEDED_STATES = ["JOB_STATE_SUCCEEDED", "SUCCEEDED"];

const jobStore = new Map();
let rabbitWorkerStarted = false;
let rabbitWorkerStarting = null;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function processBatchJob(batchName) {
  const cached = jobStore.get(batchName);
  if (!cached) {
    console.warn(`Missing local cache for ${batchName}`);
    return;
  }

  try {
    cached.status = "PROCESSING";
    cached.message = "Waiting for Gemini batch completion.";
    cached.updatedAt = new Date().toISOString();

    let job = null;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
      job = await getBatchStatus(batchName);
      const state = job.state ?? "UNKNOWN";

      cached.state = state;
      cached.pollAttempts = attempt;
      cached.updatedAt = new Date().toISOString();

      if (FAILED_STATES.includes(state)) {
        cached.status = "FAILED";
        cached.error = `Batch job ended with state: ${state}`;
        return;
      }

      if (SUCCEEDED_STATES.includes(state)) {
        cached.status = "GENERATING_VARIANTS";
        cached.message = "Generating and uploading variant images.";
        cached.updatedAt = new Date().toISOString();
        cached.result = await buildResultPayload(batchName, job, cached);
        cached.status = "COMPLETED";
        cached.message = cached.result.message;
        cached.completedAt = new Date().toISOString();
        cached.updatedAt = cached.completedAt;
        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    cached.status = "TIMED_OUT";
    cached.error = `Batch did not finish after ${MAX_POLL_ATTEMPTS} polling attempts.`;
    cached.updatedAt = new Date().toISOString();
  } catch (err) {
    cached.status = "FAILED";
    cached.error = err.message;
    cached.updatedAt = new Date().toISOString();
    throw err;
  }
}

async function startRabbitWorker() {
  if (rabbitWorkerStarted) return true;
  if (rabbitWorkerStarting) return rabbitWorkerStarting;

  rabbitWorkerStarting = (async () => {
    try {
      await consumeJobs(async ({ batchName }) => {
        if (!batchName) throw new Error("RabbitMQ job is missing batchName");
        console.log(`[Worker] Processing ${batchName}`);
        await processBatchJob(batchName);
      });
      rabbitWorkerStarted = true;
      console.log(`Consuming queue "${RABBITMQ_QUEUE}"`);
      return true;
    } catch (err) {
      console.error(
        `Worker disabled: ${formatRabbitError(err)}. ` +
          `Make sure RabbitMQ is running at ${RABBITMQ_URL}.`,
      );
      return false;
    } finally {
      rabbitWorkerStarting = null;
    }
  })();

  return rabbitWorkerStarting;
}

async function startRabbitWorkerOnBoot() {
  try {
    await startRabbitWorker();
  } catch (_err) {}
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
    jobStore.set(batchJob.name, {
      imageBuffer: req.file.buffer,
      mimeType,
      inputImageUrl,
      variantCount,
      state: batchJob.state,
      status: "QUEUED",
      message: "Queued for background variant generation.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let queued = false;
    try {
      queued = await publishJob({ batchName: batchJob.name });
      startRabbitWorker();
    } catch (err) {
      const cached = jobStore.get(batchJob.name);
      cached.status = "QUEUE_FAILED";
      cached.queueError = err.message;
      cached.message =
        "RabbitMQ publish failed. Completed batches can still be processed via GET /results.";
      console.error("Publish failed:", formatRabbitError(err));
    }

    return res.status(202).json({
      batchName: batchJob.name,
      state: batchJob.state,
      status: jobStore.get(batchJob.name).status,
      variantCount,
      inputImageUrl,
      queued,
      queue: RABBITMQ_QUEUE,
      message: queued
        ? `Batch job submitted and queued with ${variantCount} variant requests.`
        : `Batch job submitted with ${variantCount} variant requests, but RabbitMQ queueing failed.`,
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
    const cached = jobStore.get(batchName);

    if (cached?.result) {
      return res.json(cached.result);
    }

    if (
      cached &&
      !["QUEUE_FAILED", "FAILED", "TIMED_OUT"].includes(cached.status)
    ) {
      return res.status(202).json({
        batchName,
        state: cached.state ?? "UNKNOWN",
        status: cached.status,
        message:
          cached.message ??
          "Batch job is queued or processing in the background.",
        pollAttempts: cached.pollAttempts ?? 0,
        inputImageUrl: cached.inputImageUrl,
        updatedAt: cached.updatedAt,
      });
    }

    const job = await getBatchStatus(batchName);
    const state = job.state ?? "UNKNOWN";

    if (FAILED_STATES.includes(state)) {
      return res.status(422).json({
        batchName,
        state,
        error: `Batch job ended with state: ${state}`,
      });
    }

    if (!SUCCEEDED_STATES.includes(state)) {
      return res.json({
        batchName,
        state,
        message: "Batch job is still processing. Please poll again later.",
        completionStats: job.completionStats ?? null,
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
    cached.result = result;
    cached.status = "COMPLETED";
    cached.message = result.message;
    cached.completedAt = new Date().toISOString();
    cached.updatedAt = cached.completedAt;

    return res.json(result);
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
    rabbitmq: {
      queue: RABBITMQ_QUEUE,
    },
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
  startRabbitWorkerOnBoot();
});

process.on("SIGINT", async () => {
  await closeRabbitMq();
  process.exit(0);
});

module.exports = app;
