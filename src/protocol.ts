// Wire protocol between the brain app (phone) and the generic glasses terminal (.ehpk).
//
// The brain composes Even container specs and sends them DOWN on the `render` topic;
// the terminal proxies them verbatim to the SDK bridge. The terminal forwards glasses
// input events back UP on the `input` topic. Neither side imports the other's logic —
// only these plain shapes cross the wire.

export const RENDER_TOPIC = 'render'
export const INPUT_TOPIC = 'input'
export const AUDIO_TOPIC = 'audio'

// ── Container specs (plain-object mirrors of the SDK container classes) ──────────
// Kept loose on purpose so the brain depends on no SDK types; the terminal builds the
// real SDK classes (TextContainerProperty, …) from these.

export interface TextContainerSpec {
  xPosition?: number
  yPosition?: number
  width?: number
  height?: number
  borderWidth?: number
  borderColor?: number
  borderRadius?: number
  paddingLength?: number
  containerID?: number
  containerName?: string
  isEventCapture?: number
  content?: string
}

export interface ImageContainerSpec {
  xPosition?: number
  yPosition?: number
  width?: number
  height?: number
  containerID?: number
  containerName?: string
}

export interface ListItemSpec {
  itemCount?: number
  itemWidth?: number
  isItemSelectBorderEn?: number
  itemName?: string[]
}

export interface ListContainerSpec extends TextContainerSpec {
  itemContainer?: ListItemSpec
}

export interface PageSpec {
  containerTotalNum?: number
  textObject?: TextContainerSpec[]
  imageObject?: ImageContainerSpec[]
  listObject?: ListContainerSpec[]
}

export interface TextUpgradeSpec {
  containerID?: number
  containerName?: string
  content?: string
  contentOffset?: number
  contentLength?: number
}

export interface ImageUpdateSpec {
  containerID?: number
  containerName?: string
  imageData?: number[] | string
}

// ── Down channel: brain → terminal ──────────────────────────────────────────────
export type RenderCommand =
  | { op: 'page'; page: PageSpec }            // terminal: createStartUpPageContainer first, rebuildPageContainer after
  | { op: 'text'; upgrade: TextUpgradeSpec }  // textContainerUpgrade
  | { op: 'image'; image: ImageUpdateSpec }   // updateImageRawData
  | { op: 'exit'; exitMode?: number }         // shutDownPageContainer
  | { op: 'mic'; on: boolean }                // bridge.audioControl(on) — open/close the glasses mic

// ── Up channel: terminal → brain ─────────────────────────────────────────────────
export type InputAction = 'click' | 'double-click' | 'scroll-up' | 'scroll-down'

export type InputMessage =
  | { kind: 'hello'; launchSource?: string }
  | { kind: 'event'; action: InputAction }
  | { kind: 'exit-request' }

// ── Up channel: terminal → brain (audio) ─────────────────────────────────────────
// One chunk of glasses-mic PCM, base64-encoded. Assumed 16 kHz, mono, signed 16-bit LE.
export interface AudioMessage {
  pcm: string // base64 of the raw PCM bytes
}
