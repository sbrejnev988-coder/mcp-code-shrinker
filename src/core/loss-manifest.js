// ═══ Loss Manifest v2.0 ═══
// Every compressed packet must honestly report what was lost.

export function createLossManifest() {
  return {
    originalTokens: 0,
    packetTokens: 0,
    removed: {
      comments: 0,
      unrelatedSymbols: 0,
      testBodies: 0,
      implementationBodies: 0,
      files: 0,
    },
    preserved: {
      targetSource: false,
      publicContracts: false,
      errorPaths: false,
      sideEffects: false,
      relatedTests: false,
    },
    risk: "low",
    retrievableIds: [],
  };
}

export function finalizeLossManifest(manifest, packet) {
  // Calculate risk level
  const { removed, preserved } = manifest;
  
  // Risk checks
  if (!preserved.targetSource && !preserved.publicContracts) {
    manifest.risk = "critical";
  } else if (!preserved.targetSource) {
    manifest.risk = "high";
  } else if (removed.implementationBodies > 5 && !preserved.sideEffects) {
    manifest.risk = "medium";
  } else if (removed.implementationBodies > 10) {
    manifest.risk = "medium";
  }
  
  manifest.packetTokens = packet.tokens || 0;
  
  return manifest;
}
