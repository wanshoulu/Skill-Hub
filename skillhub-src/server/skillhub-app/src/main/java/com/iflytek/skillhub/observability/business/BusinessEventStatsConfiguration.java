package com.iflytek.skillhub.observability.business;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/** Independent lifecycle from the OTLP business-logs pipeline; feeds the PG detail table for the stats service. */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(BusinessEventStatsProperties.class)
@ConditionalOnProperty(prefix = "skillhub.observability.business-stats", name = "enabled", havingValue = "true")
public class BusinessEventStatsConfiguration {
    @Bean
    BusinessEventStatsListener businessEventStatsListener(JdbcTemplate jdbcTemplate) {
        return new BusinessEventStatsListener(jdbcTemplate);
    }
}
