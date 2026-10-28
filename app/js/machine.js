// What this PC has for geometry work, and how many geometry kernels may work at once on it. Each kernel is a worker
// of its own: one processor thread, and memory for the part it holds (a few hundred MB, more for big parts). So
// the number comes from the PC's processor threads and its free memory, read when RazorCAD starts (and again when
// another kernel is wanted), not from any one machine's figures.
//
//   machineInfo()    { threads, freeMB, totalMB }: free memory from Windows in the desktop app; in a browser only
//                    roughly (the browser gives its own rounded figure for the PC's memory, at most 8 GB)
//   kernelBudget(m)  kernels at once: a thread each beyond two (the window and the rest of the PC), about 1 GB of
//                    free memory each beyond 2 GB; at least 2 (a drawing or assembly never waits on the part), at
//                    most 16
//   memoryFor(m, n)  whether there is free memory for n more kernels
//   threadsPerKernel(threads)  threads for a part's kernel (the multi-threaded kernel, where the page is cross-origin
//                    isolated): half the threads beyond two, 2 to 8 (a golf ball with 179 faces: 6.0 s on one
//                    thread, 4.9 s on 4, 4.7 s on 8, no faster on 16 or 22, which only start slower); 1 on a PC with
//                    fewer than 6 threads (the first part's kernel: all but one with 4 or 5, two with 2 or 3) or where
//                    threads can't be used

import { platform } from './platform.js';

export async function machineInfo() {
  const threads = navigator.hardwareConcurrency || 4;
  let freeMB = null, totalMB = null;
  try {
    await platform.ready; // (the desktop app's bridge, which tells the free memory)
    const s = await platform.systemInfo();
    if (s) { freeMB = s.freeMB ?? null; totalMB = s.totalMB ?? null; }
  } catch { /* not known */ }
  if (totalMB == null && navigator.deviceMemory) totalMB = navigator.deviceMemory * 1024;
  return { threads, freeMB, totalMB };
}

// (free memory when known, else three quarters of the PC's: the browser gives only a rounded total)
const freeOf = (m) => m.freeMB ?? (m.totalMB != null ? m.totalMB * 0.75 : 4096);

export function kernelBudget(m) {
  const byCpu = Math.max(1, (m.threads || 4) - 2);
  const byMem = Math.max(1, Math.floor((freeOf(m) - 2048) / 1024));
  return Math.max(2, Math.min(16, byCpu, byMem));
}

export function threadsPerKernel(threads = navigator.hardwareConcurrency || 4, isolated = !!globalThis.crossOriginIsolated, front = false) {
  // (the browser version too, where the website serves it cross-origin isolated: website/_headers)
  if (!isolated || typeof SharedArrayBuffer === 'undefined' || threads < 2) return 1;
  // (Kernel Lab: the first part's kernel all the threads but two, at most 22 — it now meshes, reads faces and edges and
  // boxes faces in parallel: check set 6.45 s on 8 threads, 6.02 on 12, 5.92 on 16, 5.74 on 22 — and every other
  // kernel 8 as before: 22 for every kernel hung the test suite once several parts were open. On a PC with 4 or 5
  // threads the first part's kernel all but one, the others one: held to 4 threads, one a core, the check set 16.3 s
  // on one thread, 10.8 on 2, 9.2 on 3, 8.4 on 4; on 2 cores with 4 threads 17.7 s on one, 11.7 on 3; the same
  // geometry and meshes). On a PC with 2 or 3 threads the first part's kernel two: held to 2 cores the check set
  // 18.2 s on one thread, 12.8 s on 2 (edits 4.39 / 4.15 s); to one core with hyper-threading 23.2 / 19.7 s (edits
  // 5.52 / 4.89 s); 3 threads on 2 cores were slower than 2; the same geometry and meshes
  if (front) return threads < 4 ? 2 : threads < 6 ? threads - 1 : Math.max(2, Math.min(22, threads - 2));
  if (threads < 6) return 1;
  return Math.max(2, Math.min(8, Math.floor((threads - 2) / 2)));
}

export function memoryFor(m, n = 1) {
  return freeOf(m) - n * 1024 >= 1536;
}
