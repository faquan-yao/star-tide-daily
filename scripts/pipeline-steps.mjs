/**
 * star-tide-daily 四步流水线定义（与 workflows/star-tide-daily.lobster 对齐）
 */

export const PIPELINE_STEPS = {
  trending: {
    id: "trending",
    agent: "github-trending",
    promptFile: "prompts/trending.md",
    timeout: 1800,
    stdinFrom: null,
  },
  analyze: {
    id: "analyze",
    agent: "opensource-analyzer",
    promptFile: "prompts/analyze.md",
    timeout: 7200,
    stdinFrom: "trending",
  },
  ppt_preview: {
    id: "ppt_preview",
    agent: "ppt-maker",
    promptFile: "prompts/ppt-preview.md",
    timeout: 3600,
    stdinFrom: "analyze",
  },
  ppt_finalize: {
    id: "ppt_finalize",
    agent: "ppt-maker",
    promptFile: "prompts/ppt-finalize.md",
    timeout: 3600,
    stdinFrom: "ppt_preview",
  },
};

export const STEP_IDS = Object.keys(PIPELINE_STEPS);

export function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

export function resolveRunDate(runDate) {
  return (runDate && String(runDate).trim()) || todayDate();
}

export function getStepDef(stepId) {
  const def = PIPELINE_STEPS[stepId];
  if (!def) {
    throw new Error(`未知步骤: ${stepId}（可选: ${STEP_IDS.join(", ")}）`);
  }
  return def;
}

/** artifacts/<date>/.pipeline/ */
export function pipelineStateDir(outputDir, runDate) {
  return `${outputDir}/${resolveRunDate(runDate)}/.pipeline`;
}

export function pipelineStatePath(outputDir, runDate, stepId) {
  return `${pipelineStateDir(outputDir, runDate)}/${stepId}.json`;
}

export function previousStepId(stepId) {
  return getStepDef(stepId).stdinFrom;
}
