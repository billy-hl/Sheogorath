'use strict';
const http = require('http');

const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = 8188;

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (options.encoding === 'binary') {
          resolve({ status: res.statusCode, data: raw });
        } else {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw.toString()) }); }
          catch { resolve({ status: res.statusCode, data: raw.toString() }); }
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// Node graph mirrors ComfyUI's official image_krea2_turbo_t2i template:
// Turbo is distilled for 8-step/cfg-1 sampling; negative comes from
// ConditioningZeroOut since real negative prompts do nothing at cfg 1.
function buildWorkflow(prompt) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "krea2_turbo_fp8_scaled.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], positive: ["4", 0], negative: ["5", 0],
        latent_image: ["6", 0], seed, steps: 8, cfg: 1.0,
        sampler_name: "euler", scheduler: "simple", denoise: 1.0
      }
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "sheogorath" } }
  };
}

async function queuePrompt(workflow) {
  const body = JSON.stringify({ prompt: workflow });
  const res = await httpRequest({
    hostname: COMFY_HOST, port: COMFY_PORT,
    path: '/prompt', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (res.status !== 200) throw new Error(`ComfyUI queue error: ${res.status} - ${JSON.stringify(res.data)}`);
  return res.data.prompt_id;
}

async function waitForImage(promptId, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await httpRequest({
      hostname: COMFY_HOST, port: COMFY_PORT,
      path: `/history/${promptId}`, method: 'GET'
    });
    const history = res.data[promptId];
    if (history?.outputs?.['9']?.images?.[0]) {
      return history.outputs['9'].images[0];
    }
    if (history?.status?.status_str === 'error') {
      throw new Error(`ComfyUI generation failed: ${JSON.stringify(history.status.messages ?? [])}`);
    }
  }
  throw new Error('ComfyUI timed out waiting for image.');
}

async function fetchImageBuffer(filename, subfolder = '', type = 'output') {
  const path = `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;
  const res = await httpRequest({
    hostname: COMFY_HOST, port: COMFY_PORT,
    path, method: 'GET', encoding: 'binary'
  });
  if (res.status !== 200) throw new Error(`ComfyUI fetch image error: ${res.status}`);
  return res.data;
}

/**
 * Generate an image from a text prompt using local ComfyUI + Krea 2 Turbo (fp8).
 */
async function generateImage(prompt) {
  const workflow = buildWorkflow(prompt);
  const promptId = await queuePrompt(workflow);
  console.log(`[Krea2] Queued prompt ${promptId}`);
  const imageInfo = await waitForImage(promptId);
  console.log(`[Krea2] Image ready: ${imageInfo.filename}`);
  return await fetchImageBuffer(imageInfo.filename, imageInfo.subfolder, imageInfo.type);
}

module.exports = { generateImage };
