import { JiraIssueCreateUnknownError } from "./jira-issue-create.js";
import { ReviewPipelineStore, type PipelineJob } from "./review-pipeline-store.js";

interface DecisionTarget { chatId: number; topicId: number; messageId: number; }
interface JiraPort {
  findByLabel(label: string): Promise<{ key: string; url: string } | undefined>;
  create(job: PipelineJob, label: string): Promise<{ key: string; url: string }>;
}
type Outcome = { outcome: "created" | "continuing" | "unknown" | "unavailable"; job?: PipelineJob };

export class ReviewPipelineActions {
  constructor(private readonly options: {
    store: ReviewPipelineStore;
    jira?: JiraPort;
    openAnalysis: (job: PipelineJob) => Promise<number>;
  }) {}

  async decide(id: string, decision: "create" | "continue", target: DecisionTarget): Promise<Outcome> {
    const { store, jira } = this.options;
    let job = store.get(id);
    if (!job || job.chatId !== target.chatId || job.topicId !== target.topicId || job.messageId !== target.messageId) {
      return { outcome: "unavailable" };
    }
    if (job.status === "created") return { outcome: "created", job };
    if (job.status === "continuing" && job.analysisTopicId) return { outcome: "continuing", job };
    if (decision === "continue") {
      if (job.status === "awaiting") job = store.claimDecision(id, decision, target.chatId, target.topicId, target.messageId);
      if (!job || job.status !== "continuing") return { outcome: "unavailable" };
      const topicId = await this.options.openAnalysis(job);
      return { outcome: "continuing", job: store.analysisOpened(id, topicId) };
    }
    if (!jira) return { outcome: "unavailable" };
    const fresh = job.status === "awaiting";
    if (fresh) job = store.claimDecision(id, decision, target.chatId, target.topicId, target.messageId);
    if (!job || job.status !== "creating") return { outcome: "unavailable" };
    const label = `telecodex-review-${id}`;
    let existing: { key: string; url: string } | undefined;
    try { existing = await jira.findByLabel(label); }
    catch {
      if (fresh) store.releaseDecision(id);
      return { outcome: "unknown", job };
    }
    if (existing) return { outcome: "created", job: store.created(id, existing.key, existing.url) };
    // A previous POST may have succeeded before its response was lost. Lookup is safe; a second POST is not.
    if (!fresh) return { outcome: "unknown", job };
    let created: { key: string; url: string };
    try {
      created = await jira.create(job, label);
    } catch (error) {
      if (!(error instanceof JiraIssueCreateUnknownError)) store.releaseDecision(id);
      return { outcome: "unknown", job };
    }
    // A local persistence failure after a successful POST must keep the creation guard in place.
    return { outcome: "created", job: store.created(id, created.key, created.url) };
  }
}
