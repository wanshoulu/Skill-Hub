package com.iflytek.skillhub.observability.business;

import com.iflytek.skillhub.domain.event.BusinessEventSnapshot;
import com.iflytek.skillhub.domain.event.PromotionApprovedEvent;
import com.iflytek.skillhub.domain.event.PromotionRejectedEvent;
import com.iflytek.skillhub.domain.event.ReviewApprovedEvent;
import com.iflytek.skillhub.domain.event.ReviewRejectedEvent;
import com.iflytek.skillhub.domain.event.SkillBusinessEvent;
import com.iflytek.skillhub.domain.event.SkillDownloadedEvent;
import com.iflytek.skillhub.domain.event.SkillPublishedEvent;
import com.iflytek.skillhub.domain.event.SkillStatusChangedEvent;
import com.iflytek.skillhub.domain.event.SkillVersionYankedEvent;
import com.iflytek.skillhub.domain.event.SkillVisibilityChangedEvent;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Statistics-only PG detail row; same O(1) snapshot discipline as the OTLP pipeline, failures never propagate. */
public final class BusinessEventStatsListener {
    private static final Logger log = LoggerFactory.getLogger(BusinessEventStatsListener.class);
    private static final Set<String> SOURCES = Set.of("auto_publish", "private_confirm", "review", "promotion",
            "download", "governance", "visibility");
    private static final String INSERT = """
            INSERT INTO business_event_log(event_name, skill_id, namespace_id, visibility, version_id,
                actor_type, user_id, source, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            """;

    private final JdbcTemplate jdbc;

    BusinessEventStatsListener(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @EventListener
    public void onEvent(SkillBusinessEvent event) {
        try {
            resolve(event).ifPresent(this::schedule);
        } catch (RuntimeException ex) {
            log.warn("business event stats capture failed", ex);
        }
    }

    private void schedule(Row row) {
        if (TransactionSynchronizationManager.isActualTransactionActive()
                && TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { insert(row); }
            });
        } else {
            insert(row);
        }
    }

    private void insert(Row row) {
        try {
            jdbc.update(INSERT, row.eventName(), row.skillId(), row.namespaceId(), row.visibility(),
                    row.versionId(), row.actorType(), row.userId(), row.source(), Timestamp.from(row.occurredAt()));
        } catch (RuntimeException ex) {
            log.warn("business event stats insert failed for {}", row.eventName(), ex);
        }
    }

    private Optional<Row> resolve(SkillBusinessEvent event) {
        BusinessEventSnapshot snapshot = event.snapshot();
        if (snapshot == null || snapshot.namespaceId() == null || snapshot.visibility() == null
                || snapshot.occurredAt() == null || event.skillId() == null
                || snapshot.namespaceId() <= 0 || event.skillId() <= 0
                || snapshot.source() == null || snapshot.actorType() == null
                || !SOURCES.contains(snapshot.source())
                || !Set.of("user", "system").contains(snapshot.actorType())) {
            return Optional.empty();
        }
        String name;
        Long versionId;
        switch (event) {
            case SkillPublishedEvent e -> { name = "skill.publication.effective"; versionId = e.versionId(); }
            case SkillDownloadedEvent e -> { name = "skill.download.prepared"; versionId = e.versionId(); }
            case ReviewApprovedEvent e -> { name = "skill.review.approved"; versionId = e.versionId(); }
            case ReviewRejectedEvent e -> { name = "skill.review.rejected"; versionId = e.versionId(); }
            case PromotionApprovedEvent e -> { name = "skill.promotion.approved"; versionId = null; }
            case PromotionRejectedEvent e -> { name = "skill.promotion.rejected"; versionId = null; }
            case SkillStatusChangedEvent e -> {
                if (e.oldStatus() == null || e.newStatus() == null || e.oldStatus() == e.newStatus()) { return Optional.empty(); }
                name = "skill.status.changed";
                versionId = null;
            }
            case SkillVisibilityChangedEvent e -> {
                if (e.previousVisibility() == null || e.visibility() == null || e.previousVisibility() == e.visibility()) { return Optional.empty(); }
                name = "skill.visibility.changed";
                versionId = null;
            }
            case SkillVersionYankedEvent e -> {
                if (!e.wasPublished()) { return Optional.empty(); }
                name = "skill.version.yanked";
                versionId = e.versionId();
            }
            default -> { return Optional.empty(); }
        }
        String userId = "user".equals(snapshot.actorType()) && snapshot.actorId() != null && !snapshot.actorId().isBlank()
                ? bounded(snapshot.actorId()) : null;
        return Optional.of(new Row(name, event.skillId(), snapshot.namespaceId(), snapshot.visibility().name(),
                versionId, snapshot.actorType(), userId, snapshot.source(), snapshot.occurredAt()));
    }

    static String bounded(String value) {
        return value.length() <= 128 ? value : value.substring(0, 128);
    }

    private record Row(String eventName, Long skillId, Long namespaceId, String visibility, Long versionId,
                       String actorType, String userId, String source, Instant occurredAt) {}
}
