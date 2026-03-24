---
name: video-generation
description: Generate videos from text prompts using Google's Veo model. Creates short video clips with cinematic quality via the generate_video tool.
emoji: "\U0001F3AC"
---

# Video Generation

Generate videos from text descriptions using Google's Veo model via the `generate_video` tool.

## Setup

1. Enable video generation in Settings UI or set `NOMOS_VIDEO_GENERATION=true`
2. Get a Gemini API key from https://aistudio.google.com/apikey (same key used for image generation)
3. Set `GEMINI_API_KEY` in Settings or environment

## Tool: `generate_video`

**Parameters:**

- `prompt` (required) — Detailed description of the video to generate
- `output_path` (optional) — File path to save the video (defaults to temp directory)
- `duration_seconds` (optional) — Video duration in seconds (1-30)

**Note:** Video generation is a long-running operation. It typically takes 1-3 minutes to complete.

## Writing Effective Video Prompts

Good video prompts describe motion and time, not just a static scene. Include:

- **Subject and action**: What is happening, who/what is moving
- **Camera work**: Pan, tilt, zoom, tracking shot, static, drone shot, handheld
- **Scene setting**: Location, time of day, weather, environment
- **Style**: Cinematic, documentary, slow motion, timelapse, animation
- **Mood and atmosphere**: Lighting, color grading, emotional tone
- **Temporal flow**: What happens first, then next

### Prompt Examples

**Simple:**

> A drone shot slowly flying over a misty mountain range at sunrise

**Cinematic:**

> A slow-motion close-up of a coffee cup being filled with espresso, steam rising, warm golden light from a nearby window, shallow depth of field, cinematic color grading

**Action:**

> A tracking shot following a cyclist riding through autumn leaves on a tree-lined path, golden hour lighting, leaves swirling in their wake

**Abstract:**

> Flowing liquid mercury forming geometric shapes in zero gravity, reflecting prismatic light, smooth transitions between forms, dark background, studio lighting

**Narrative:**

> A time-lapse of a flower blooming in a garden, starting from a tight bud to full bloom, morning dew evaporating, soft natural lighting, macro lens perspective

## Camera Movement Keywords

- **Static**: Fixed camera, no movement
- **Pan**: Horizontal camera rotation (left/right)
- **Tilt**: Vertical camera rotation (up/down)
- **Zoom**: Moving closer or further (zoom in/out)
- **Tracking/dolly**: Camera moves alongside the subject
- **Drone/aerial**: Overhead or elevated perspective
- **Handheld**: Slight natural camera shake
- **Orbit**: Camera circles around the subject
- **Crane**: Vertical camera movement (rising/lowering)

## Style Keywords

- **Cinematic**: Film-quality, 24fps feel, color graded
- **Documentary**: Natural, observational
- **Slow motion**: Time-stretched action
- **Timelapse**: Compressed time
- **Hyperlapse**: Moving timelapse
- **Animation**: Animated/cartoon style
- **Vintage/retro**: Film grain, muted colors
- **Noir**: High contrast, dramatic shadows

## Output

- Videos are saved as MP4 (default) or WebM
- Default save location is the system temp directory
- Specify `output_path` to save to a specific location

## Tips

- Be specific about camera movement — it dramatically changes the result
- Describe what changes over time, not just a static scene
- Include lighting and atmosphere details for cinematic quality
- Keep prompts focused on a single coherent scene
- Shorter durations tend to produce higher quality results
