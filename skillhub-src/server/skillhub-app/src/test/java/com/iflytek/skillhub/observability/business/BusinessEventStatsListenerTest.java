package com.iflytek.skillhub.observability.business;

import com.iflytek.skillhub.domain.event.BusinessEventSnapshot;
import com.iflytek.skillhub.domain.event.ReviewApprovedEvent;
import com.iflytek.skillhub.domain.event.SkillBusinessEvent;
import com.iflytek.skillhub.domain.event.SkillDownloadedEvent;
import com.iflytek.skillhub.domain.event.SkillPublishedEvent;
import com.iflytek.skillhub.domain.skill.SkillVisibility;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class BusinessEventStatsListenerTest {
    private final Instant occurredAt = Instant.parse("2026-10-01T00:00:00Z");
    private final Timestamp occurred = Timestamp.from(occurredAt);
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final BusinessEventStatsListener listener = new BusinessEventStatsListener(jdbc);

    @AfterEach
    void clearTransactionState() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.clearSynchronization();
        }
        TransactionSynchronizationManager.setActualTransactionActive(false);
    }

    @Test
    void systemActorIsStoredWithoutUserId() {
        var system = new BusinessEventSnapshot(7L, SkillVisibility.PRIVATE, "builtin-skill-publisher", "system",
                "auto_publish", occurredAt);
        listener.onEvent(new ReviewApprovedEvent(3L, 5L, 11L, "builtin-skill-publisher", "owner", system));
        verify(jdbc).update(contains("business_event_log"), eq("skill.review.approved"), eq(5L), eq(7L),
                eq("PRIVATE"), eq(11L), eq("system"), isNull(), eq("auto_publish"), eq(occurred));
    }

    @Test
    void downloadEventInsertCarriesSnapshotFields() {
        var snapshot = new BusinessEventSnapshot(7L, SkillVisibility.PUBLIC, "download-user", "user", "download",
                occurredAt);
        listener.onEvent(new SkillDownloadedEvent(5L, 9L, snapshot));
        verify(jdbc).update(contains("business_event_log"), eq("skill.download.prepared"), eq(5L), eq(7L),
                eq("PUBLIC"), eq(9L), eq("user"), eq("download-user"), eq("download"), eq(occurred));
    }

    @Test
    void withoutActiveTransactionInsertRunsInline() {
        var snapshot = new BusinessEventSnapshot(7L, SkillVisibility.PRIVATE, "publisher", "user", "auto_publish",
                occurredAt);
        listener.onEvent(new SkillPublishedEvent(1L, 2L, "publisher", snapshot));
        verify(jdbc, times(1)).update(anyString(), eq("skill.publication.effective"), eq(1L), eq(7L),
                eq("PRIVATE"), eq(2L), eq("user"), eq("publisher"), eq("auto_publish"), eq(occurred));
    }

    @Test
    void activeTransactionDelaysInsertUntilAfterCommit() {
        TransactionSynchronizationManager.setActualTransactionActive(true);
        TransactionSynchronizationManager.initSynchronization();
        var snapshot = new BusinessEventSnapshot(7L, SkillVisibility.PUBLIC, "downloader", "user", "download",
                occurredAt);
        listener.onEvent(new SkillDownloadedEvent(1L, 2L, snapshot));
        verifyNoInteractions(jdbc);
        List<TransactionSynchronization> synchronizations = TransactionSynchronizationManager.getSynchronizations();
        assertThat(synchronizations).hasSize(1);
        synchronizations.getFirst().afterCommit();
        verify(jdbc).update(anyString(), eq("skill.download.prepared"), eq(1L), eq(7L), eq("PUBLIC"), eq(2L),
                eq("user"), eq("downloader"), eq("download"), eq(occurred));
    }

    @Test
    void insertFailureNeverPropagatesToBusinessThread() {
        when(jdbc.update(anyString(), eq("skill.download.prepared"), eq(1L), eq(7L), eq("PUBLIC"), eq(2L),
                eq("user"), eq("downloader"), eq("download"), eq(occurred)))
                .thenThrow(new IllegalStateException("database unavailable"));
        var snapshot = new BusinessEventSnapshot(7L, SkillVisibility.PUBLIC, "downloader", "user", "download",
                occurredAt);
        assertThatCode(() -> listener.onEvent(new SkillDownloadedEvent(1L, 2L, snapshot))).doesNotThrowAnyException();
    }

    @Test
    void unknownEventTypesAndNullSnapshotsAreIgnored() {
        record UnmappedEvent(Long skillId, BusinessEventSnapshot snapshot) implements SkillBusinessEvent {}
        assertThatCode(() -> {
            listener.onEvent(new UnmappedEvent(1L, new BusinessEventSnapshot(7L, SkillVisibility.PUBLIC, "actor",
                    "user", "download", occurredAt)));
            listener.onEvent(new SkillDownloadedEvent(1L, 2L, null));
        }).doesNotThrowAnyException();
        verifyNoInteractions(jdbc);
    }
}
