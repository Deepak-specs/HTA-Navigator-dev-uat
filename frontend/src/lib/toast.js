/**
 * toast.js — lightweight toast using a DOM element with id "v2-toast".
 * The Layout component renders <div id="v2-toast" className="v2-toast"> and
 * <span id="v2-toast-msg"> inside it.  This module drives the animation.
 */
let timer = null;

export function toast(msg) {
  const el  = document.getElementById("v2-toast");
  const txt = document.getElementById("v2-toast-msg");
  if (!el || !txt) return;
  txt.textContent = msg;
  el.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove("show"), 2600);
}
