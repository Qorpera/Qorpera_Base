/** One tool result's envelope (`qorpera.cloud-tool-result/v1`), escaping and provenance included: at most 32 KiB
 * (32,768 bytes; 8 KiB until perf sprint T2). The patched Codex's result fence pins it (`MAX_RESULT_BYTES`), the
 * runtime fits every result to it (its `MAX_CLOUD_TOOL_RESULT_BYTES` is this constant), a run log's step keeps such an
 * envelope whole (`memory-run-files.ts`, as `qorpera_memory_run_step_line` does), and the run's context view checks it
 * (`qorpera_folder_record_context_view`; both since 20260930733000). One constant, so no reader of what the runtime
 * keeps can fall behind the bound it writes to. */
export const CLOUD_TOOL_RESULT_MAX_BYTES = 32 * 1024;
