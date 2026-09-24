# The public host. Built from build/deploy, which scripts/stage.ts assembles;
# the repo itself holds nothing of the game, so it cannot be the build context.
#
# The image carries the game's files: push it only to a PRIVATE registry.
FROM oven/bun:1.4.0-slim

# Content, the extracted Opus audio, and the reference copy the ownership
# check compares against. Mount a volume here instead to keep them out of the image.
COPY game /game
COPY app /srv
RUN ln -s /game/Content /srv/wwwroot/Content && ln -s /game/Audio /srv/wwwroot/Audio

WORKDIR /srv
# TRUST_PROXY: the platform's TLS proxy is the only way in, so its
# X-Forwarded-For is the client. Set OWNERSHIP_KEY (openssl rand -hex 32) in
# the platform's variables, or every redeploy asks each player to verify again.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    TRUST_PROXY=1 \
    WWWROOT=/srv/wwwroot \
    FRAMEWORK_ROOT=/srv/framework \
    OWNERSHIP_REFERENCE="/game/Stardew Valley.dll" \
    OWNERSHIP_SECRET=/tmp/ownership-key
EXPOSE 8080
USER bun
CMD ["bun", "scripts/serve.ts"]
