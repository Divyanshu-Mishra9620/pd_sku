const GENERATION_PROMPT = `Generate exactly one image per sample (never a collage, grid, tiled layout, or multi-panel composition).
The image must depict only a tight crop of a single instance of the product shown in the reference image. No additional products, no repetition, and no surrounding shelf context.

Product Identity (STRICT — NON-NEGOTIABLE)
The product must remain exactly identical to the reference:
- Preserve exact packaging colors (no hue, saturation, or brightness shifts)
- Preserve branding, logo, and all text exactly (no distortion, rewriting, or hallucination)
- Preserve shape, proportions, and layout
- Under no circumstance should the model modify or reinterpret the product.
- Lighting effects may reduce visibility, but must not change the underlying true color of the product.

Objective: Extreme Low-Quality Realism
The output must look like a genuinely poor-quality capture from a low-end smartphone or security camera.
Apply an aggressive degradation pipeline:
- Render at very low resolution (<320×240)
- Upscale using nearest-neighbor interpolation
- Apply multiple rounds (2–3 passes) of heavy JPEG compression
- Introduce visible pixelation, blockiness, ringing artifacts, and color noise
The final image must:
- Lose fine detail (small text should be partially unreadable)
- Have blocky edges and jagged contours
- Show obvious compression artifacts and noise
- Look visibly degraded, not clean or sharp

Allowed Variations (Environment Only)
Variation is allowed only in capture conditions, never in the product itself:
- Underexposed or overexposed lighting
- Harsh or uneven shadows
- Slight camera angle or perspective shifts
- Motion blur or focus issues
- Sensor noise, glare, or partial occlusion

Strict Negative Constraints
- No collage, no multiple panels, no side-by-side comparisons
- No duplicated or repeated products
- No clean, high-resolution, or studio-like output
- No color shifts or reinterpretation of packaging
- No added elements, backgrounds, or creative edits

Final Output Requirement
The result must look like a single authentic low-quality crop taken from a real shelf image—imperfect, noisy, and degraded, but with product identity perfectly preserved.`;

module.exports = { GENERATION_PROMPT };
