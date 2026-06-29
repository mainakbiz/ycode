'use client';

import React from 'react';

/**
 * Placeholder shown on the canvas the instant an AI build starts, before the
 * first real layers stream in. Gives immediate feedback (rather than a blank
 * page) and is replaced by the actual content as it arrives — which then reveals
 * itself step by step via the canvas entrance animation.
 */
const BLOCKS: Array<{ className: string; delay: number }> = [
  { className: 'h-3 w-24 rounded-full bg-neutral-200', delay: 0 },
  { className: 'h-10 w-3/4 rounded-lg bg-neutral-200', delay: 0.1 },
  { className: 'h-10 w-2/3 rounded-lg bg-neutral-200', delay: 0.2 },
  { className: 'h-4 w-1/2 rounded bg-neutral-200/80', delay: 0.3 },
];

export default function CanvasBuildSkeleton() {
  return (
    <div
      className="absolute inset-0 z-10 overflow-hidden pointer-events-none"
      aria-hidden="true"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-5 px-8 pt-24">
        {BLOCKS.map((block, index) => (
          <div
            key={index}
            className={`animate-pulse ${block.className}`}
            style={{ animationDelay: `${block.delay}s` }}
          />
        ))}

        <div className="flex gap-3 pt-2">
          <div
            className="h-10 w-32 animate-pulse rounded-lg bg-neutral-300"
            style={{ animationDelay: '0.4s' }}
          />
          <div
            className="h-10 w-28 animate-pulse rounded-lg bg-neutral-200"
            style={{ animationDelay: '0.5s' }}
          />
        </div>

        <div className="grid w-full grid-cols-3 gap-4 pt-12">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-32 animate-pulse rounded-xl bg-neutral-200"
              style={{ animationDelay: `${0.6 + index * 0.1}s` }}
            />
          ))}
        </div>

        <div className="flex items-center gap-2 pt-10 text-sm text-neutral-400">
          <span className="size-1.5 animate-pulse rounded-full bg-neutral-400" />
          Building your page…
        </div>
      </div>
    </div>
  );
}
