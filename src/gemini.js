const { GoogleGenAI } = require("@google/genai");
const { GENERATION_PROMPT } = require("./prompt");
const BATCH_MODEL = process.env.BATCH_MODEL || "gemini-2.5-flash";
const FREE_IMAGE_MODELS = [
  "gemini-3.1-flash-image-preview",
  "gemini-2.5-flash-image",
];
const IMAGE_GEN_MODEL = process.env.IMAGE_GEN_MODEL || "gemini-2.5-flash-image";

if (!FREE_IMAGE_MODELS.includes(IMAGE_GEN_MODEL)) {
  throw new Error(
    `Unsupported IMAGE_GEN_MODEL "${IMAGE_GEN_MODEL}". Supported free-capable models: ${FREE_IMAGE_MODELS.join(", ")}`,
  );
}

const VARIATION_SEEDS = [
  "severe underexposure, camera pressed against shelf glass, extreme motion blur",
  "harsh fluorescent flicker artifact, lens smear, heavy sensor noise",
  "overexposed from side-aisle window glare, washed highlights, grain",
  "extreme upward angle, perspective distortion, dusty lens",
  "near-darkness, only amber emergency lighting, maximum ISO noise",
  "downward bird-eye angle, partial occlusion by price tag corner",
  "foggy refrigerated aisle condensation on lens, diffuse glow",
  "direct flash blowout on label center, harsh shadow edges",
  "tilted 15 degrees clockwise, slight defocus, chromatic aberration",
  "deep shadow from adjacent tall product, crushed blacks",
  "warm tungsten-only aisle, colour cast, grain, low contrast",
  "security camera fisheye distortion, CRT scan-line artifact",
  "camera shake vertical streak, motion blur dominant axis",
  "partial shelf-edge occlusion bottom third, heavy JPEG blocking",
  "midday skylight from aisle skylight, zebra stripe overexposure",
  "strong blue-cast white-balance error, grain, noise",
  "shelf reflection ghost on product front, double-edge artifact",
  "extreme close-up, DOF razor-thin, edges melting into bokeh",
  "backlighting silhouette edge, underexposed front face",
  "high humidity haze, diffuse soft blur across entire frame",
  "forklift aisle vibration, radial motion blur from centre",
  "dirty wide-angle lens smear, vignette heavy corners",
  "night-mode attempt, colour desaturation, luminance noise",
  "flickering LED strobe artifact, banding horizontal",
  "rain-wet floor reflection partial mirror below product",
  "security cam timestamp watermark overlay top-left corner",
  "store intercom speaker shadow hard line across label",
  "cross-aisle ambient bleed, green tinted shadow",
  "zoom-in digital crop artefact, mosaic pixelation fringe",
  "double-exposure ghost of adjacent product ghost image faint",
  "extreme barrel distortion from budget wide-lens",
  "ceiling grid shadow pattern across product face",
  "auto-HDR failure haloing around label edges",
  "ISO push to 12800, colour noise dominates midtones",
  "partial hand/finger occlusion lower-left quadrant",
  "shelf-lip steel edge reflection streak across cap",
  "EV-2 underexposure recovery with heavy noise lift",
  "portrait mode bokeh misfire, product edge blurred",
  "auto-white-balance hunting artefact, magenta-green shift",
  "macro minimum focus distance front blur band",
  "shopping-cart wire shadow grid across label",
  "strong side-light single source, half face in shadow",
  "freeze-frame from video stream, interlace combing",
  "dusty sensor spot black dots on bright background area",
  "screen-shot of CCTV monitor, moire pattern from screen pixels",
  "thermal-camera false-colour bleed at label edges",
  "extreme pincushion distortion from low-quality zoom",
  "blown-out specular highlight from product shrink-wrap",
  "low-battery camera auto-shutdown artefact, dark vignette ring",
  "wide dynamic range failure, simultaneous blown+crushed zones",
];

let _ai = null;

function getClient() {
  if (!_ai) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("env is not set");
    }
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _ai;
}
async function uploadImageToFilesApi(imageBuffer, mimeType) {
  const ai = getClient();
  const blob = new Blob([imageBuffer], { type: mimeType });
  const uploadedFile = await ai.files.upload({
    file: blob,
    config: { mimeType, displayName: `packshot_${Date.now()}` },
  });
  if (!uploadedFile?.uri) {
    throw new Error("Files API upload returned no URI");
  }
  console.log(`Packshot uploaded to Files API: ${uploadedFile.uri}`);
  return uploadedFile.uri;
}
function buildDescriptionRequests(fileUri, count) {
  return Array.from({ length: count }, (_, i) => {
    const seed = VARIATION_SEEDS[i % VARIATION_SEEDS.length];
    return {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `You are a scene-description expert for a low-quality product image generator.\n` +
                `Study the reference packshot carefully, then write a single detailed image-generation prompt ` +
                `(under 120 words) describing this EXACT product photographed under these degraded conditions:\n` +
                `VARIATION SEED: ${seed}\n\n` +
                `Rules:\n` +
                `- Describe the product identity faithfully (colors, logo, text, shape) — DO NOT change it.\n` +
                `- Focus the rest of the prompt on the degraded capture conditions from the seed.\n` +
                `- Output ONLY the prompt text, nothing else.\n` +
                `\nReference packshot:`,
            },
            {
              fileData: {
                mimeType: "image/png",
                fileUri: fileUri,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.9,
        topP: 0.95,
        maxOutputTokens: 200,
      },
    };
  });
}
async function submitBatchJob(fileUri, count = 50) {
  const ai = getClient();
  const requests = buildDescriptionRequests(fileUri, count);

  console.log(
    `Submitting batch job with ${requests.length} description requests...`,
  );

  const batchJob = await ai.batches.create({
    model: BATCH_MODEL,
    src: requests,
    config: {
      displayName: `pd-sku-descriptions-${Date.now()}`,
    },
  });

  console.log(`Batch job created: ${batchJob.name} | state: ${batchJob.state}`);
  return batchJob;
}
async function generateSingleVariant(description, imageBuffer, mimeType) {
  const ai = getClient();

  const base64Image = imageBuffer.toString("base64");

  const response = await ai.models.generateContent({
    model: IMAGE_GEN_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: description + "\n\n" + GENERATION_PROMPT },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Image,
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ["Text", "Image"],
      temperature: 1.0,
      topP: 0.95,
    },
  });

  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, "base64");
    }
  }

  const text = parts
    .filter((part) => part.text)
    .map((part) => part.text.trim())
    .join(" ");

  throw new Error(
    text
      ? `Image generation returned no image data. Model text response: ${text}`
      : "Image generation returned no image data",
  );
}
async function generateAllVariants(descriptions, imageBuffer, mimeType) {
  console.log(
    `Generating ${descriptions.length} image variants in parallel...`,
  );

  const results = await Promise.allSettled(
    descriptions.map((desc, i) =>
      generateSingleVariant(desc, imageBuffer, mimeType).then((buf) => ({
        index: i + 1,
        buffer: buf,
      })),
    ),
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.error(`[Gemini] Variant ${i + 1} failed: ${r.reason?.message}`);
    return { index: i + 1, error: r.reason?.message ?? "Unknown error" };
  });
}
async function getBatchStatus(batchName) {
  const ai = getClient();
  return ai.batches.get(batchName);
}

function extractDescriptions(completedJob) {
  const descriptions = [];
  const responses = completedJob.inlineResponses ?? [];

  for (const inlineResp of responses) {
    const parts = inlineResp?.response?.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text.trim())
      .join(" ");

    descriptions.push(
      text ||
        "A degraded low-quality product photograph with heavy compression artifacts.",
    );
  }

  return descriptions;
}

module.exports = {
  uploadImageToFilesApi,
  submitBatchJob,
  getBatchStatus,
  extractDescriptions,
  generateAllVariants,
  BATCH_MODEL,
  IMAGE_GEN_MODEL,
  FREE_IMAGE_MODELS,
};
