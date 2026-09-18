import type {
  LayerId,
  SessionId,
  SessionLock,
  SessionLockAdapter,
} from "@zettaai/edit-session";

import { WatchableValue } from "#src/trackable_value.js";

interface ActiveSession {
  readonly sessionId: SessionId;
  readonly sessionLayerIds: ReadonlySet<LayerId>;
}

// Approach (a): host calls setActiveSession/clearActiveSession around acquire/release.
export class NgSessionLockAdapter implements SessionLockAdapter {
  readonly activeSession = new WatchableValue<ActiveSession | undefined>(
    undefined,
  );
  /**
   * Layers of an `editSession` intent being restored (URL/hash load), set by
   * the host for the duration of a restore attempt. Locked like the active
   * session's layers: deleting or renaming one before the restore finishes
   * makes it fail and clears the intent.
   */
  readonly restoringLayerIds = new WatchableValue<
    ReadonlySet<LayerId> | undefined
  >(undefined);
  private locked = false;

  async acquire(sessionId: SessionId): Promise<SessionLock> {
    if (this.locked) {
      throw new Error("SessionLock: another session is active");
    }
    this.locked = true;
    const acquiredAt = performance.now();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.locked = false;
      if (
        this.activeSession.value !== undefined &&
        this.activeSession.value.sessionId === sessionId
      ) {
        this.activeSession.value = undefined;
      }
    };
    return {
      sessionId,
      acquiredAt,
      release,
    };
  }

  setActiveSession(active: ActiveSession): void {
    this.activeSession.value = active;
  }

  clearActiveSession(): void {
    this.activeSession.value = undefined;
  }

  /**
   * Whether `layerId` is one of the active session's layers, writable or
   * reference, or, while no session is active, one of the layers of a session
   * being restored ({@link restoringLayerIds}). While it is, NG's own UI must
   * not change the layer's structure (delete, rename, change its type or data
   * sources): the session addresses its layers by name and paints through
   * their render layers, so any of those breaks the session, or the restore,
   * and a reload after a delete or rename cannot restore it. Only the UI
   * consults this; model-level mutations and state restore stay unguarded so
   * the embedding host can still replace the state.
   */
  isSessionLayer(layerId: LayerId): boolean {
    const active = this.activeSession.value;
    if (active !== undefined) return active.sessionLayerIds.has(layerId);
    return this.restoringLayerIds.value?.has(layerId) ?? false;
  }
}
