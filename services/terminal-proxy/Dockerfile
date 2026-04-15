FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

COPY . .

EXPOSE 3001

ENV HOSTNAME=0.0.0.0

CMD ["npm", "run", "start"]
