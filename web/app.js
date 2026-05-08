const TARGET_SAMPLE_RATE = 16000;
const TARGET_CHUNK_SIZE = 512;
const MAX_TIMELINE_ITEMS = 12;
const MAX_STATE_STRIP_ITEMS = 30;

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const stateLabel = document.querySelector("#stateLabel");
const stateHint = document.querySelector("#stateHint");
const stateRing = document.querySelector(".state-ring");
const endpointBadge = document.querySelector("#endpointBadge");
const meterFill = document.querySelector("#meterFill");
const stateStrip = document.querySelector("#stateStrip");
const latencyValue = document.querySelector("#latencyValue");
const chunkCount = document.querySelector("#chunkCount");
const backendName = document.querySelector("#backendName");
const applyStatus = document.querySelector("#applyStatus");
const endpointPreset = document.querySelector("#endpointPreset");
const resetParamsButton = document.querySelector("#resetParamsButton");
const timeline = document.querySelector("#timeline");
const timelineItemTemplate = document.querySelector("#timelineItemTemplate");

const paramInputs = {
  confidence: document.querySelector("#confidenceInput"),
  min_volume: document.querySelector("#minVolumeInput"),
  start_secs: document.querySelector("#startSecsInput"),
  stop_secs: document.querySelector("#stopSecsInput"),
};

const paramValueLabels = {
  confidence: document.querySelector("#confidenceValue"),
  min_volume: document.querySelector("#minVolumeValue"),
  start_secs: document.querySelector("#startSecsValue"),
  stop_secs: document.querySelector("#stopSecsValue"),
};

const endpointPresets = {
  responsive: { start_secs: 0.12, stop_secs: 0.18 },
  balanced: { start_secs: 0.2, stop_secs: 0.25 },
  stable: { start_secs: 0.32, stop_secs: 0.45 },
};

const stateDescriptions = {
  QUIET: "No voice detected",
  STARTING: "Voice entering threshold window",
  SPEAKING: "Speech confirmed",
  STOPPING: "Speech trailing off",
};

let audioContext;
let mediaStream;
let sourceNode;
let processorNode;
let pendingSamples = [];
let sending = false;
let active = false;
let sentChunks = 0;
let lastState = "QUIET";
let starting = false;
let endpointFlashTimer;
let applyTimer;
let currentParams;
let defaultParams;
let applyRequestToken = 0;

function setApplyStatus(message, tone = "neutral") {
  applyStatus.textContent = message;
  applyStatus.dataset.tone = tone;
}

function formatParamValue(name, value) {
  if (name === "start_secs" || name === "stop_secs") {
    return `${Math.round(value * 1000)} ms`;
  }
  return value.toFixed(2);
}

function syncParamLabels(params) {
  for (const [name, input] of Object.entries(paramInputs)) {
    input.value = String(params[name]);
    paramValueLabels[name].textContent = formatParamValue(name, params[name]);
  }
}

function inferPreset(params) {
  for (const [name, preset] of Object.entries(endpointPresets)) {
    if (
      Math.abs(params.start_secs - preset.start_secs) < 0.005 &&
      Math.abs(params.stop_secs - preset.stop_secs) < 0.005
    ) {
      return name;
    }
  }
  return "custom";
}

function readParamsFromControls() {
  return {
    confidence: Number(paramInputs.confidence.value),
    min_volume: Number(paramInputs.min_volume.value),
    start_secs: Number(paramInputs.start_secs.value),
    stop_secs: Number(paramInputs.stop_secs.value),
  };
}

function writeParamsToControls(params) {
  currentParams = { ...params };
  syncParamLabels(currentParams);
  endpointPreset.value = inferPreset(currentParams);
}

function setControls({ startDisabled, stopDisabled, startLabel }) {
  startButton.disabled = startDisabled;
  stopButton.disabled = stopDisabled;
  startButton.textContent = startLabel;
}

function updateState(state) {
  stateLabel.textContent = state;
  stateHint.textContent = stateDescriptions[state] ?? "Waiting for data";
  stateRing.dataset.state = state;
}

function appendStateStripItem(state) {
  const node = document.createElement("span");
  node.className = "state-strip-item";
  node.dataset.state = state;
  node.title = state;
  node.setAttribute("aria-label", state);
  stateStrip.append(node);

  while (stateStrip.children.length > MAX_STATE_STRIP_ITEMS) {
    stateStrip.removeChild(stateStrip.firstElementChild);
  }

  stateStrip.scrollTo({ left: stateStrip.scrollWidth, behavior: "smooth" });
}

function triggerEndpointFlash() {
  window.clearTimeout(endpointFlashTimer);
  stateRing.classList.remove("endpoint-flash");
  endpointBadge.classList.remove("visible");
  void stateRing.offsetWidth;
  stateRing.classList.add("endpoint-flash");
  endpointBadge.classList.add("visible");

  endpointFlashTimer = window.setTimeout(() => {
    stateRing.classList.remove("endpoint-flash");
    endpointBadge.classList.remove("visible");
  }, 2200);
}

function appendTimeline(state, latencyMs) {
  const stamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const node = timelineItemTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.state = state;
  node.querySelector(".timeline-state").textContent = state;
  node.querySelector(".timeline-meta").textContent = `${stamp} · ${latencyMs} ms`;
  timeline.prepend(node);

  while (timeline.children.length > MAX_TIMELINE_ITEMS) {
    timeline.removeChild(timeline.lastElementChild);
  }
}

function updateMeter(floatSamples) {
  let sumSquares = 0;
  for (const sample of floatSamples) {
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / Math.max(floatSamples.length, 1));
  const percent = Math.min(rms * 220, 100);
  meterFill.style.width = `${percent}%`;
}

function downsampleBuffer(floatSamples, inputRate, outputRate) {
  if (inputRate === outputRate) {
    return floatSamples;
  }

  const ratio = inputRate / outputRate;
  const newLength = Math.round(floatSamples.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let index = offsetBuffer; index < nextOffsetBuffer && index < floatSamples.length; index += 1) {
      accum += floatSamples[index];
      count += 1;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function floatToInt16Bytes(floatSamples) {
  const pcm = new Int16Array(floatSamples.length);
  for (let index = 0; index < floatSamples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatSamples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

async function sendChunk(floatSamples) {
  const startedAt = performance.now();
  const payload = floatToInt16Bytes(floatSamples);

  const response = await fetch("/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: payload,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  const result = await response.json();
  const latencyMs = Math.round(performance.now() - startedAt);
  latencyValue.textContent = `${latencyMs} ms`;
  sentChunks += 1;
  chunkCount.textContent = String(sentChunks);

  if (lastState === "STOPPING" && result.state === "QUIET") {
    triggerEndpointFlash();
  }

  updateState(result.state);
  appendStateStripItem(result.state);

  if (result.state !== lastState) {
    appendTimeline(result.state, latencyMs);
    lastState = result.state;
  }
}

async function resetBackend() {
  const response = await fetch("/reset", { method: "POST" });
  if (!response.ok) {
    throw new Error(`Reset failed with ${response.status}`);
  }
}

async function fetchParams() {
  const response = await fetch("/params");
  if (!response.ok) {
    throw new Error(`Params unavailable (${response.status})`);
  }
  return response.json();
}

async function pushParams(params) {
  const response = await fetch("/params", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Update failed with ${response.status}`);
  }

  return response.json();
}

async function checkBackend() {
  const response = await fetch("/health");
  if (!response.ok) {
    throw new Error(`Backend unavailable (${response.status})`);
  }
  return response.json();
}

async function applyParams(params, statusMessage = "Updated") {
  const requestToken = ++applyRequestToken;
  setApplyStatus("Applying...", "pending");

  const result = await pushParams(params);
  if (requestToken !== applyRequestToken) {
    return;
  }

  backendName.textContent = result.backend;
  writeParamsToControls(result.params);
  setApplyStatus(statusMessage, "success");
}

function scheduleParamApply(statusMessage = "Updated") {
  window.clearTimeout(applyTimer);
  setApplyStatus("Pending change...", "pending");

  applyTimer = window.setTimeout(async () => {
    try {
      await applyParams(readParamsFromControls(), statusMessage);
    } catch (error) {
      console.error(error);
      setApplyStatus(error instanceof Error ? error.message : "Unable to update", "error");
    }
  }, 180);
}

async function loadConfig() {
  const [health, paramsPayload] = await Promise.all([checkBackend(), fetchParams()]);
  backendName.textContent = health.backend;
  defaultParams = { ...paramsPayload.defaults };
  writeParamsToControls(paramsPayload.params);
  setApplyStatus("Ready", "success");
  stateHint.textContent = `Ready · backend ${health.backend}`;
}

async function flushPendingSamples() {
  if (sending || !active) {
    return;
  }

  while (pendingSamples.length >= TARGET_CHUNK_SIZE && active) {
    sending = true;
    const samples = pendingSamples.splice(0, TARGET_CHUNK_SIZE);
    try {
      await sendChunk(Float32Array.from(samples));
    } catch (error) {
      console.error(error);
      stateHint.textContent = error.message;
      await stopMonitoring();
      break;
    } finally {
      sending = false;
    }
  }
}

async function startMonitoring() {
  if (active || starting) {
    return;
  }

  starting = true;
  setControls({ startDisabled: true, stopDisabled: true, startLabel: "Starting..." });
  stateHint.textContent = "Checking backend";

  await checkBackend();
  await resetBackend();

  stateHint.textContent = "Requesting microphone access";

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(2048, 1, 1);
  pendingSamples = [];
  sending = false;
  active = true;
  starting = false;
  sentChunks = 0;
  chunkCount.textContent = "0";
  updateState("QUIET");
  timeline.innerHTML = "";
  stateStrip.innerHTML = "";
  appendStateStripItem("QUIET");
  appendTimeline("QUIET", 0);
  lastState = "QUIET";

  processorNode.onaudioprocess = (event) => {
    if (!active) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    updateMeter(input);

    const downsampled = downsampleBuffer(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
    for (const sample of downsampled) {
      pendingSamples.push(sample);
    }

    void flushPendingSamples();
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
  setControls({ startDisabled: true, stopDisabled: false, startLabel: "Monitoring" });
  stateHint.textContent = "Listening for speech";
}

async function stopMonitoring() {
  active = false;
  starting = false;
  setControls({ startDisabled: false, stopDisabled: true, startLabel: "Start monitoring" });
  meterFill.style.width = "0%";

  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  pendingSamples = [];
  stateHint.textContent = "Microphone idle";
  stateRing.classList.remove("endpoint-flash");
  endpointBadge.classList.remove("visible");
  window.clearTimeout(endpointFlashTimer);

  try {
    await resetBackend();
  } catch (error) {
    console.error(error);
  }
}

startButton.addEventListener("click", async () => {
  try {
    await startMonitoring();
  } catch (error) {
    console.error(error);
    starting = false;
    setControls({ startDisabled: false, stopDisabled: true, startLabel: "Try again" });
    stateHint.textContent = error instanceof Error ? error.message : "Unable to start monitoring";
  }
});

stopButton.addEventListener("click", async () => {
  await stopMonitoring();
});

endpointPreset.addEventListener("change", () => {
  if (endpointPreset.value === "custom") {
    return;
  }

  const preset = endpointPresets[endpointPreset.value];
  paramInputs.start_secs.value = String(preset.start_secs);
  paramInputs.stop_secs.value = String(preset.stop_secs);
  paramValueLabels.start_secs.textContent = formatParamValue("start_secs", preset.start_secs);
  paramValueLabels.stop_secs.textContent = formatParamValue("stop_secs", preset.stop_secs);
  scheduleParamApply(`Preset ${endpointPreset.value} applied`);
});

for (const [name, input] of Object.entries(paramInputs)) {
  input.addEventListener("input", () => {
    const value = Number(input.value);
    paramValueLabels[name].textContent = formatParamValue(name, value);
    if (name === "start_secs" || name === "stop_secs") {
      endpointPreset.value = inferPreset(readParamsFromControls());
    }
    scheduleParamApply("Parameters updated");
  });
}

resetParamsButton.addEventListener("click", async () => {
  if (!defaultParams) {
    return;
  }

  try {
    await applyParams(defaultParams, "Defaults restored");
  } catch (error) {
    console.error(error);
    setApplyStatus(error instanceof Error ? error.message : "Unable to reset", "error");
  }
});

updateState("QUIET");
setControls({ startDisabled: false, stopDisabled: true, startLabel: "Start monitoring" });
setApplyStatus("Loading...", "pending");

void loadConfig().then(
  () => {},
  (error) => {
    backendName.textContent = "offline";
    setApplyStatus("Backend unavailable", "error");
    stateHint.textContent = error instanceof Error ? error.message : "Backend unavailable";
    setControls({ startDisabled: false, stopDisabled: true, startLabel: "Retry backend" });
  },
);