import { formatAlert, chunkMessage } from './format.js';
import { labelChunks } from './theme.js';
import { VisualDeliver } from '../visual/deliver.js';

/**
 * TELEGRAM_SEND stage: takes publish decisions and hands them to the transport.
 * Failures are isolated per message and recorded; never throws.
 *
 * Returns { sent: [...], failed: [...] }.
 */
export async function deliverEvents(decisions, ctx) {
  const { store, transport, logger, mode = 'intraday', now = new Date() } = ctx;
  const sent = [];
  const failed = [];

  // Visual alert delivery (optional, per VISUAL_ALERTS env)
  const visualAlerts = String(process.env.VISUAL_ALERTS ?? 'false').toLowerCase() === 'true';
  const dryRun = String(process.env.DRY_RUN ?? 'false').toLowerCase() === 'true';
  const visualDeliver = visualAlerts ? new VisualDeliver({ transport, logger, settings: {}, env: process.env }) : null;

  for (const decision of decisions) {
    if (!decision.publish) continue;
    const { event, verdict } = decision;
    // Idempotency guard: never send twice for the same story, UNLESS it's a material update.
    const isMaterialUpdate = event.detection_status === 'UPDATED';
    if (!isMaterialUpdate && event.cluster_id && store.isClusterPublished(event.cluster_id)) {
      logger?.info('TELEGRAM_SEND', `skip ${event.event_id}: cluster already published`);
      store.updateEvent?.(event.event_id, { status: 'processed' });
      continue;
    }
    const text = formatAlert(event, verdict, {
      priority: verdict?.publication_priority ?? 'high',
      footer: decision.footer ?? null,
      now,
    });
    // Split only as a last resort (fitToBudget already compacts the message);
    // label the parts so a reader can tell they continue the same story.
    const chunks = labelChunks(chunkMessage(text, 4096));

    let visualSent = false;
    let visualError = null;

    // Try visual alert first for HIGH-importance breaking events
    if (visualDeliver && verdict?.publication_priority === 'high') {
      try {
        const vr = await visualDeliver.sendAlert({ event, verdict, now, runId: event.event_id });
        if (vr.visual) {
          visualSent = true;
          logger?.info('TELEGRAM_SEND', `visual alert sent for ${event.event_id}`);
        }
      } catch (err) {
        visualError = err.message;
        logger?.warn('TELEGRAM_SEND', `visual alert failed for ${event.event_id}: ${err.message}`);
      }
    }

    let lastMessageId = null;
    try {
      // If visual alert was sent, send text only as a fallback? Per spec, alert image replaces text.
      // But for reliability, send text too if visual failed.
      if (!visualSent) {
        for (const chunk of chunks) {
          const res = await transport.send(chunk, {
            mode,
            category: event.category,
            event_id: event.event_id,
          });
          lastMessageId = res?.message_id ?? lastMessageId;
        }
      } else {
        // Visual sent - still record the text for idempotency but don't send again
        // (or send a short confirmation? Spec says don't duplicate)
        logger?.info('TELEGRAM_SEND', `visual alert sent, skipping text for ${event.event_id}`);
      }
      const textHash = text.slice(0, 64);
      store.recordPublished({
        event_id: event.event_id,
        cluster_id: event.cluster_id,
        chat_id: transport.chatId ?? null,
        message_id: lastMessageId === null ? null : String(lastMessageId),
        mode,
        template: visualSent ? 'alert_visual_v1' : 'alert_v1',
        text_hash: textHash,
        raw_text: text,
        published_at: now.toISOString(),
      });
      store.updateCluster?.(event.cluster_id, { publish_status: 'published' });
      store.updateEvent?.(event.event_id, { status: 'published', event_status: 'published' });
      sent.push({ event_id: event.event_id, message_id: lastMessageId, dry_run: res_is_dry(lastMessageId), visual: visualSent });
      logger?.info('TELEGRAM_SEND', `published ${event.event_id} (${event.category})`, {
        title: event.title?.slice(0, 80),
        priority: verdict?.publication_priority ?? null,
        transport: transport.name,
        visual: visualSent,
      });
    } catch (err) {
      failed.push({ event_id: event.event_id, error: err.message });
      store.updateEvent?.(event.event_id, { status: 'failed' });
      logger?.error('TELEGRAM_SEND', `send failed for ${event.event_id}: ${err.message}`);
    }
  }

  return { sent, failed };
}

function res_is_dry(messageId) {
  return messageId === null || messageId === undefined;
}
