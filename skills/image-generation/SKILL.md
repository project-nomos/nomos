---
name: image-generation
description: Generate images from text prompts using Google's Gemini model. Creates photorealistic images, illustrations, concept art, and more via the generate_image tool.
emoji: "\U0001F3A8"
---

# Image Generation

Generate images from text descriptions using Google's Gemini model via the `generate_image` tool.

## Setup

1. Enable image generation in Settings UI or set `NOMOS_IMAGE_GENERATION=true`
2. Get a Gemini API key from https://aistudio.google.com/apikey
3. Set `GEMINI_API_KEY` in Settings or environment

## Tool: `generate_image`

**Parameters:**

- `prompt` (required) — Detailed description of the image to generate
- `output_path` (optional) — File path to save the image (defaults to temp directory)

## Writing Effective Prompts

Good image prompts are specific about:

- **Subject**: What is in the image (person, object, scene)
- **Style**: Photorealistic, watercolor, oil painting, digital art, pencil sketch, etc.
- **Composition**: Close-up, wide shot, aerial view, symmetrical, rule of thirds
- **Lighting**: Golden hour, studio lighting, dramatic shadows, soft diffused light
- **Colors**: Warm palette, monochrome, vibrant, muted pastels
- **Mood**: Serene, dramatic, playful, mysterious

### Prompt Examples

**Simple:**

> A golden retriever sitting in a field of sunflowers at sunset

**Detailed:**

> A photorealistic close-up of a steaming cup of coffee on a weathered wooden table, morning light streaming through a window, shallow depth of field, warm color palette

**Artistic:**

> An Art Nouveau illustration of a woman surrounded by flowing botanical patterns, muted earth tones with gold accents, decorative border, inspired by Alphonse Mucha's style

**Technical:**

> An isometric 3D rendering of a modern smart home cutaway showing interior rooms, clean minimal style, soft shadows, pastel color scheme on white background

## Capabilities

- Photorealistic images
- Illustrations and concept art
- Logos and icons
- Diagrams and infographics (with text)
- Image editing via text description (describe modifications)
- Multiple art styles (watercolor, oil, digital, pixel art, etc.)

## Output

- Images are saved as PNG (default), JPEG, or WebP
- Default save location is the system temp directory
- Specify `output_path` to save to a specific location (e.g., current working directory)

## Tips

- More detail in prompts produces better results
- Specify image dimensions or aspect ratio in the prompt if needed
- For consistent style across multiple images, include the same style descriptors
- The model may also return text alongside the image with notes about what it generated
