# Madhuban Backend (Next.js + TypeScript)

Role-based backend with hierarchy:
- `admin`
- `manager`
- `supervisor`
- `staff`

Flow implemented:
- Default roles and default users are seeded
- `master_tasks` are created by admin
- `staff_master_tasks` assign a master task to staff with `startDate` and `endDate`
- Daily cron generation creates day-wise records in `daily_staff_tasks`
- Property and department masters are included (`properties`, `property_departments`)
- Floor-wise zone master is included (`property_floor_zones`)

## Tech Stack
- Next.js (App Router)
- TypeScript
- Prisma ORM
- Neon Postgres
- JWT auth (`jose`)

## Setup
1. Create `.env` from `.env.example`
   - Set `DATABASE_URL` to your Neon connection string
   - If calling this API from a different origin (separate frontend), set `CORS_ORIGIN_ALLOWLIST`
2. Install dependencies:
```bash
npm install
```
3. Generate Prisma client:
```bash
npm run prisma:generate
```
4. Run migrations:
```bash
npm run prisma:migrate -- --name init
```
5. Seed default roles/users:
```bash
npm run prisma:seed
```
6. Start server:
```bash
npm run dev
```

## Default Users
- Admin: `admin@madhuban360.com` / `Admin@123`
- Manager: `manager@madhuban360.com` / `Manager@123`
- Supervisor: `supervisor@madhuban360.com` / `Supervisor@123`
- Staff: `staff@madhuban360.com` / `Staff@123`

Hierarchy seeded:
- manager -> supervisor -> staff

## APIs

### Login
`POST /api/auth/login`

Request:
```json
{
  "email": "admin@madhuban360.com",
  "password": "Admin@123"
}
```

### Roles
`GET /api/roles`

### Users (paginated)
`GET /api/users?page=1&limit=10`

### Supervisors
`GET /api/users/supervisors`

### Managers
`GET /api/users/managers`

### Staff
`GET /api/users/staff`

### Supervisor Profile
`GET /api/supervisor/profile`

### Master Tasks (admin create)
- `GET /api/tasks`
- `POST /api/tasks` (Bearer token, admin only)

Example request:
```json
{
  "title": "Daily Reporting",
  "description": "Submit shift report"
}
```

### Staff Master Tasks (assignment)
- `GET /api/staff-master-tasks`
- `POST /api/staff-master-tasks` (Bearer token)

Example request:
```json
{
  "staffId": 4,
  "masterTaskId": 1,
  "startDate": "2026-03-28T00:00:00.000Z",
  "endDate": "2026-04-15T00:00:00.000Z"
}
```

### Run Daily Task Cron Manually
`POST /api/cron/daily-tasks` (Bearer token, admin only)

### Daily Staff Tasks by date
`GET /api/daily-staff-tasks?date=2026-03-28`

### Properties
- `GET /api/properties`
- `POST /api/properties`

### Property Departments
- `GET /api/property-departments`
- `POST /api/property-departments`

### Property Floors
- `GET /api/property-floors`
- `POST /api/property-floors`

### Property Floor Zones
- `GET /api/property-floor-zones`
- `POST /api/property-floor-zones`

## Cron Script
Run manually:
```bash
npm run cron:run
```

This script:
- runs once immediately
- schedules every day at 00:00 (server timezone)

For production, use your process manager (PM2/systemd/Docker cron) to keep this process alive.

## EC2 cron (recommended: call API once/day)
Your backend exposes an admin-only endpoint:
- `POST /api/cron/daily-tasks`

On EC2, the simplest and most reliable setup is **Linux cron calling the API once per day**, logging in each run to obtain a fresh JWT.

1) Create a secure env file on EC2:

```bash
sudo mkdir -p /etc/madhuban
sudo bash -c 'cat > /etc/madhuban/cron.env <<EOF
CRON_BASE_URL=http://127.0.0.1:3000
CRON_ADMIN_EMAIL=admin@madhuban360.com
CRON_ADMIN_PASSWORD=REPLACE_ME
EOF'
sudo chmod 600 /etc/madhuban/cron.env
```

2) Copy the script from this repo to EC2 and make it executable:
- `scripts/ec2/run-daily-tasks-cron-via-api.sh`

3) Add the cron entry (runs at **00:00 IST** regardless of EC2 timezone):

```bash
sudo crontab -e
```

Add:

```cron
CRON_TZ=Asia/Kolkata
0 0 * * * . /etc/madhuban/cron.env; /path/to/madhuban_backend/scripts/ec2/run-daily-tasks-cron-via-api.sh >>/var/log/madhuban-cron.log 2>&1
```

4) Test once manually (SSH session):

```bash
. /etc/madhuban/cron.env
/path/to/madhuban_backend/scripts/ec2/run-daily-tasks-cron-via-api.sh
tail -n 200 /var/log/madhuban-cron.log
```
