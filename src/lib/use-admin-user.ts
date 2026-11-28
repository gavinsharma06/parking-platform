"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("focus", onChange);
  return () => window.removeEventListener("focus", onChange);
}

function readAdminUser() {
  return document.cookie.match(/(?:^|;\s*)admin_user=([^;]+)/)?.[1] ?? "";
}

const readServerAdminUser = () => "";

export function useAdminUser() {
  return useSyncExternalStore(subscribe, readAdminUser, readServerAdminUser);
}
