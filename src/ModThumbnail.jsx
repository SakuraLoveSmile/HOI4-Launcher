import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useRef, useState } from "react";

// A state scan produces new mod objects. Share reads between the library and
// details for that scan, while allowing Refresh to pick up changed covers.
const reads = new WeakMap();
const waiting = [];
let active = 0;
function schedule(read) {
  return new Promise((resolve, reject) => {
    waiting.push({
      read,
      resolve,
      reject,
    });
    drain();
  });
}
function drain() {
  while (active < 2 && waiting.length) {
    const next = waiting.shift();
    active++;
    Promise.resolve()
      .then(next.read)
      .then(next.resolve, next.reject)
      .finally(() => {
        active--;
        drain();
      });
  }
}
async function displayImage(result) {
  if (
    !/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/.test(
      result?.dataUrl || "",
    )
  )
    return null;
  const image = new Image();
  image.src = result.dataUrl;
  await image.decode();
  const scale = Math.min(
    1,
    512 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  // Keep a small display copy rather than retaining full cover files in the list.
  return canvas.toDataURL("image/webp", 0.84);
}
function thumbnail(api, mod) {
  let mods = reads.get(api);
  if (!mods) {
    mods = new WeakMap();
    reads.set(api, mods);
  }
  if (!mods.has(mod)) {
    mods.set(
      mod,
      schedule(async () =>
        displayImage(await api.getModThumbnail(mod.id)),
      ).catch(() => null),
    );
  }
  return mods.get(mod);
}
export default function ModThumbnail({
  api,
  mod,
  className = "",
  fallback = null,
  eager = false,
  hideWhenEmpty = false,
}) {
  const { t, message, locale } = useI18n();
  const ref = useRef(null);
  const [visible, setVisible] = useState(eager);
  const [image, setImage] = useState(null);
  useEffect(() => {
    if (visible || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      {
        rootMargin: "160px",
      },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (
      !visible ||
      !mod.available ||
      !mod.picture ||
      typeof api.getModThumbnail !== "function"
    )
      return;
    let alive = true;
    thumbnail(api, mod).then((dataUrl) => {
      if (alive)
        setImage({
          mod,
          dataUrl,
        });
    });
    return () => {
      alive = false;
    };
  }, [api, mod, visible]);
  const source = image?.mod === mod ? image.dataUrl : null;
  if (hideWhenEmpty && !source) return null;
  return (
    <div
      ref={ref}
      className={`mod-thumbnail ${className}${source ? " has-thumbnail" : ""}`}
    >
      {source ? (
        <img
          src={source}
          alt={t("{0} 封面", {
            0: mod.name,
          })}
          decoding="async"
          loading={eager ? "eager" : "lazy"}
          draggable={false}
          onError={() =>
            setImage({
              mod,
              dataUrl: null,
            })
          }
        />
      ) : (
        fallback
      )}
    </div>
  );
}
