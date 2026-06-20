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

function buildWorkflow(prompt) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-schnell-fp8.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], positive: ["2", 0], negative: ["3", 0],
        latent_image: ["4", 0], seed, steps: 4, cfg: 1.0,
        sampler_name: "euler", scheduler: "simple", denoise: 1.0
      }
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "sheogorath" } }
  };
}

async function queuePrompt(workflow) {
  const body = JSON.stringify({ prompt: workflow });
  const res = await httpRequest({
    hostname: COMFY_HOST, port: COMFY_PORT,
    path: '/prompt', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (res.status !== 200) throw new Error(`ComfyUI queue error: ${res.status}`);
  return res.data.prompt_id;
}

async function waitForImage(promptId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await httpRequest({
      hostname: COMFY_HOST, port: COMFY_PORT,
      path: `/history/${promptId}`, method: 'GET'
    });
    const history = res.data[promptId];
    if (history?.outputs?.['7']?.images?.[0]) {
      return history.outputs['7'].images[0];
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
  return res.data; // Buffer
}

/**
 * Generate an image from a text prompt using ComfyUI + FLUX.1-schnell.
 * @param {string} prompt - Text prompt
 * @returns {Promise<Buffer>} - PNG image as a Buffer
 */
async function generateImage(prompt) {
  const workflow = buildWorkflow(prompt);
  const promptId = await queuePrompt(workflow);
  console.log(`[ComfyUI] Queued prompt ${promptId}`);
  const imageInfo = await waitForImage(promptId);
  console.log(`[ComfyUI] Image ready: ${imageInfo.filename}`);
  return await fetchImageBuffer(imageInfo.filename, imageInfo.subfolder, imageInfo.type);
}

module.exports = { generateImage };
