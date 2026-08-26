import type { MircliReviewRecipe, ReviewRecipe } from "./recipe-config.js";
import {
  recipeDigestKeyboard,
  renderRecipeDigestHTML,
  type RecipeDigestKeyboard,
} from "./recipe-review-digest.js";
import type { Triage } from "./recipes.js";
import { sendRecipeMessage } from "./recipe-telegram.js";

type CodeReviewRecipe = ReviewRecipe | MircliReviewRecipe;
type DigestSender = (
  recipe: CodeReviewRecipe,
  text: string,
  replyMarkup?: RecipeDigestKeyboard,
) => Promise<unknown>;

export async function deliverReviewDigest(
  recipe: CodeReviewRecipe,
  project: string,
  runId: number,
  triage: Triage,
  send: DigestSender = sendRecipeMessage,
): Promise<void> {
  await send(
    recipe,
    renderRecipeDigestHTML({
      project,
      findings: triage.fresh,
      page: 0,
      repeatedCount: triage.repeated.length,
      suppressedCount: triage.suppressed.length,
    }),
    recipeDigestKeyboard(runId, triage.fresh, 0),
  );
}
