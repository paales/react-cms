/**
 * ChannelClient — the deploy-drain half. The claims:
 *
 *   1. A `drain` wire entry arms the one-shot reattach-on-close: the
 *      wound-down stream's settle re-fires the attach IMMEDIATELY
 *      (never waiting out the heartbeat interval), and the close is
 *      never counted toward the degrade bound.
 *   2. An EXPLICIT drain refusal (`drainRefused` on the close) retries
 *      on the short fixed cadence and never counts toward the degrade
 *      bound — arbitrarily many refusals leave the page undegraded,
 *      with pending records latched for the retry's attach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _channelConnectionClosed,
  _channelEstablished,
  _channelIsDegraded,
  _channelWireEntry,
  _registerAttachRequester,
  _resetChannelClient,
} from "../channel-client.ts"
import { TAG_DRAIN } from "../fp-trailer-marker.ts"

let attachFires = 0

beforeEach(() => {
  _resetChannelClient()
  attachFires = 0
  _registerAttachRequester(() => {
    attachFires += 1
  })
})

afterEach(() => {
  _resetChannelClient()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the drain wire entry", () => {
  it("arms reattach-on-close: the settle re-fires immediately, uncounted", () => {
    _channelEstablished("conn-drain")
    _channelWireEntry(TAG_DRAIN, new Uint8Array(0))
    expect(attachFires).toBe(0)
    // The wound-down stream settles cleanly (established, not aborted).
    _channelConnectionClosed({ aborted: false })
    expect(attachFires).toBe(1)
    expect(_channelIsDegraded()).toBe(false)
    // One-shot: a later ordinary close does not re-fire.
    _channelEstablished("conn-next")
    _channelConnectionClosed({ aborted: false })
    expect(attachFires).toBe(1)
  })
})

describe("the drain refusal", () => {
  it("retries on the fixed cadence and never counts toward the degrade bound", () => {
    vi.useFakeTimers()
    for (let i = 0; i < 6; i++) {
      _channelConnectionClosed({ drainRefused: true })
      expect(_channelIsDegraded()).toBe(false)
      vi.advanceTimersByTime(600)
    }
    // Every refusal scheduled exactly one prompt retry.
    expect(attachFires).toBe(6)
    expect(_channelIsDegraded()).toBe(false)
  })

  it("a refusal while a retry is already scheduled coalesces", () => {
    vi.useFakeTimers()
    _channelConnectionClosed({ drainRefused: true })
    _channelConnectionClosed({ drainRefused: true })
    vi.advanceTimersByTime(600)
    expect(attachFires).toBe(1)
  })
})
