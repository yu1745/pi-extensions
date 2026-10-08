import { execFile } from "node:child_process";

/** Check an actual X11 connection, including remote displays and authentication.
 * Socket existence alone is not sufficient: DISPLAY may name a TCP server, or
 * the local socket may be stale. xdpyinfo is supplied by x11-utils on Debian.
 */
export function displayWorks(display: string): Promise<boolean> {
  if (!display.trim()) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    execFile("xdpyinfo", ["-display", display], {
      timeout: 1500,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error) => {
      if (error?.code === "ENOENT") {
        reject(new Error("X display validation requires xdpyinfo (Debian/Ubuntu: install x11-utils)."));
      } else {
        resolve(!error);
      }
    });
  });
}
