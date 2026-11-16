# ClipCutter cloud server image: Node + real ffmpeg + a bold font for clip titles.
# Build:  docker build -t clipcutter-server .
# Run:    docker run -d --restart unless-stopped -p 8787:8787 -e TOKEN=your-long-secret -v clipdata:/data clipcutter-server
FROM node:20-alpine
RUN apk add --no-cache ffmpeg font-dejavu
WORKDIR /app
COPY server.js ./
ENV PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["node", "server.js"]
