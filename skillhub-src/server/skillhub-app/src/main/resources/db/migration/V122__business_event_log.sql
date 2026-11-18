CREATE TABLE business_event_log (
    id BIGSERIAL PRIMARY KEY,
    event_name VARCHAR(64) NOT NULL,
    skill_id BIGINT NOT NULL,
    namespace_id BIGINT NOT NULL,
    visibility VARCHAR(32) NOT NULL,
    version_id BIGINT,
    actor_type VARCHAR(16) NOT NULL,
    user_id VARCHAR(128),
    source VARCHAR(32) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_bel_occurred_at ON business_event_log(occurred_at);
CREATE INDEX idx_bel_skill_occurred ON business_event_log(skill_id, occurred_at);
CREATE INDEX idx_bel_event_occurred ON business_event_log(event_name, occurred_at);
