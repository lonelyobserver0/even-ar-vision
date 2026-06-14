// Level-1 on-device perception: MediaPipe object detection (fast, per-frame) and
// Tesseract OCR (slow, throttled). Everything is dynamically imported so the heavy
// WASM stays out of the initial bundle, and each loader degrades gracefully.

import type { ObjectDetector as MPObjectDetector } from '@mediapipe/tasks-vision'
import type { Worker as OcrWorker } from 'tesseract.js'

export type { MPObjectDetector, OcrWorker }

/** A single detected object: class label, confidence (0..1), and pixel box in the video's native frame. */
export interface Detection {
  label: string
  score: number
  box: { x: number; y: number; width: number; height: number }
}

const MP_VERSION = '0.10.35'
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`
const MP_MODEL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'

/** Load the MediaPipe object detector (EfficientDet-Lite, VIDEO mode). Tries GPU, falls back to CPU. */
export async function loadObjectDetector(): Promise<MPObjectDetector> {
  const { FilesetResolver, ObjectDetector } = await import('@mediapipe/tasks-vision')
  const fileset = await FilesetResolver.forVisionTasks(MP_WASM)
  const make = (delegate: 'GPU' | 'CPU') =>
    ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL, delegate },
      scoreThreshold: 0.5,
      maxResults: 12,
      runningMode: 'VIDEO',
    })
  try {
    return await make('GPU')
  } catch {
    return await make('CPU')
  }
}

/** Detected objects (label + score + pixel box) in the current video frame. `timestampMs` must increase across calls. */
export function detectObjects(detector: MPObjectDetector, video: HTMLVideoElement, timestampMs: number): Detection[] {
  const res = detector.detectForVideo(video, timestampMs)
  const dets: Detection[] = []
  for (const d of res.detections) {
    const cat = d.categories[0]
    const bb = d.boundingBox
    if (!cat?.categoryName || !bb) continue
    dets.push({
      label: cat.categoryName,
      score: cat.score ?? 0,
      box: { x: bb.originX, y: bb.originY, width: bb.width, height: bb.height },
    })
  }
  return dets
}

/** Load a Tesseract OCR worker (English). Best-effort: callers treat failure as "no OCR". */
export async function loadTextReader(): Promise<OcrWorker> {
  const { createWorker } = await import('tesseract.js')
  return createWorker('eng')
}

/** Read text from an image source (slow). Returns whitespace-collapsed text, or ''. */
export async function readText(worker: OcrWorker, source: HTMLCanvasElement): Promise<string> {
  const { data } = await worker.recognize(source)
  return (data.text || '').replace(/\s+/g, ' ').trim()
}
