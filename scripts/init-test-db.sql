-- Runs once on first container start. Separate database for jest so tests never touch dev data.
CREATE DATABASE tickets_test OWNER app;
