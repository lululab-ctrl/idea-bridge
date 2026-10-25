import { post, toast } from "./lib.js";

function keyBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

// Must be called from a tap (browsers only show the permission prompt then).
export async function enablePush(vapidPublicKey) {
  if (!pushSupported()) {
    throw new Error(
      "This browser can't show notifications here. On iPhone, add Idea Bridge to your Home Screen first (Share → Add to Home Screen) and open it from there.",
    );
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed. You can change this in your phone or browser settings.");
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }));
  await post("/api/push/subscribe", sub.toJSON());
  toast("Notifications are on for this device.");
}
