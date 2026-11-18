package com.iflytek.skillhub.observability.business;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Startup-only toggle for the statistics detail table; row retention is owned by the stats service. */
@ConfigurationProperties("skillhub.observability.business-stats")
public class BusinessEventStatsProperties {
    private boolean enabled;
    private int retentionDays = 180;

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public int getRetentionDays() { return retentionDays; }
    public void setRetentionDays(int retentionDays) { this.retentionDays = retentionDays; }
}
