# Power Tool System

The Power Tool System manages the registration, review, approval, identification, and renewal of electrical-leakage circuit (ELC) equipment and portable tools. It provides one place for users to submit equipment details, for authorized personnel to complete safety reviews, and for approved records to be accessed using QR codes.

## Who Should Use This System

- Employees registering ELC equipment or portable tools
- Authorized safety reviewers and inspectors
- Administrators managing accounts, form fields, and review questions
- Personnel checking the validity or inspection status of approved equipment

## Main Features

- ELC and Portable Tool registration
- Configurable equipment-detail fields
- Configurable safety-review questions
- Automatic approval or rejection rules
- Manual Reviewer approval and rejection
- Reviewer feedback and decision tracking
- Approved-item Quick List
- Search by equipment name or QR information
- QR-code generation and download
- Printable 2 cm by 2 cm QR image
- QR-based equipment and checklist viewing
- Expiration and renewal workflow
- Active and archived record views
- Reviewer account management
- Light and dark modes
- PostgreSQL data storage
- Session-based visitor logging

## System Areas

| Area | Purpose |
| --- | --- |
| **Quick List** | Search and review approved ELC equipment and portable tools, ordered by the nearest upcoming check date. |
| **Register** | Submit equipment details, required images, and other information for review. |
| **Reviewer** | Review pending submissions, complete the configured checklist, add feedback, and approve or reject requests. |
| **Builder** | Configure registration details, review questions, answer options, and automatic decision rules. |
| **Accounts** | Allow the Admin to add or remove authorized Reviewer accounts. |
| **Archive** | Review equipment records that are no longer active. |

## How to Use the System

### 1. Open the User View

Open the application. General users can access registration and approved-item information without signing in.

### 2. Register Equipment

Select either **ELC** or **Portable Tools**, then complete the required details and upload the requested images.

Before submitting:

- Confirm that the equipment name and identifying information are correct.
- Complete every required field.
- Use clear images that show the equipment and relevant identification or condition details.

After submission, the request is sent for review.

### 3. Review a Request

An authorized Reviewer or Admin signs in through the Reviewer view and opens a pending request.

During the review:

1. Confirm the submitted equipment details and images.
2. Complete the configured review questions.
3. Add feedback when clarification or correction is needed.
4. Approve or reject the request.

If automatic-review rules are configured, the system may approve or reject the request automatically based on the selected answers. Requests without a matching automatic rule remain available for manual review.

### 4. View Approved Equipment

Approved equipment appears in the Quick List under its correct category. Use the search field to find a record by name or QR information.

The list prioritizes equipment with the nearest upcoming check date so items requiring attention are easier to identify.

### 5. Download and Use the QR Code

Open an approved item and select **Download QR**. The generated QR image can be printed at approximately 2 cm by 2 cm and attached to the correct equipment.

Scanning the QR code opens the equipment details and its latest checklist information.

### 6. Renew an Expired Item

Use the renewal option when an approved item reaches its next-check or expiration date. Complete the updated information and submit it for review.

Renewal does not bypass the review process. The renewed record becomes active after it is approved.

### 7. Manage Builder Settings

The Admin can use the Builder to manage:

- Registration-detail fields
- Review questions
- Available answers
- Automatic approval rules
- Automatic rejection rules

Changes affect future registrations and reviews. Confirm the configuration before operators begin using the updated form.

### 8. Manage Reviewer Accounts

The Admin can add or remove Reviewer accounts. New passwords are stored as salted hashes, and the configured Admin credentials are loaded from `.env`.

### 9. Sign Out

Reviewer and Admin users should sign out after completing their work, especially on shared computers.

## Important Rules

- Only **ELC** and **Portable Tools** may be registered.
- Public users do not need to sign in to submit a registration.
- Reviewer and Admin functions require authorized credentials.
- Approval should only be given after the equipment details, images, and checklist have been verified.
- Automatic decisions follow the rules configured in the Builder.
- If no automatic rule applies, an authorized Reviewer must make the decision manually.
- Rejected requests must be corrected and submitted again when appropriate.
- Renewed equipment must pass the review process before its new record becomes active.
- QR codes must be attached only to the equipment represented by the approved record.
- Archived records are kept separately from active approved items.

## Reminders and Useful Facts

- Power Tool records are stored in PostgreSQL when the health response shows `"provider":"postgresql"`.
- Docker and the website start normally even when PostgreSQL is unreachable.
- While PostgreSQL is unavailable, the system uses the local JSON copy stored in the Docker volume. Registration, review, QR, Builder, account, and usage functions remain available.
- The backend retries PostgreSQL automatically. Local changes made during the outage are merged into PostgreSQL after the connection returns, then PostgreSQL becomes the active provider again.
- The application creates and updates its required tables automatically when the configured database user has sufficient permissions.
- Visitor logs are stored in `app."PowerTool-logs"`.
- Visitor logging is session-based: one browser or device session updates one database row instead of creating a new row for every action.
- Refreshing the same browser tab retains the session. Closing the session and opening the application again creates a new session.
- QR and checklist activity updates usage totals without creating separate action rows in the session-log table.
- Some database timestamps may appear earlier than the current Manila time because of the PostgreSQL server clock. The application currently leaves these timestamps as recorded and does not change the database-wide timezone.
- The local fallback copy survives container rebuilds in the `power_tool_data` Docker volume. Do not use `docker compose down -v` as a routine restart command.

## Running the System with Docker

This section is for the person responsible for starting the Power Tool system.

### Requirements

- Docker Desktop
- Access to the PostgreSQL database used by the application
- The complete project folder, including `docker-compose.yml`
- A configured `.env` file

The PostgreSQL server and main database must already exist for normal operation. They do not need to be reachable at the exact moment Docker starts: the application remains running and reconnects automatically. The configured PostgreSQL user must have permission to use or create the `app` schema and the required tables and indexes.

### Configure `.env`

Create `.env` in the main project folder and enter the deployment values provided by the system owner:

```env
APP_PORT=5055
TZ=Asia/Manila

POSTGRES_ENABLED=true
POSTGRES_HOST=host.docker.internal
POSTGRES_PORT=5432
POSTGRES_DB=YOUR_DATABASE
POSTGRES_USER=YOUR_DEDICATED_APP_USER
POSTGRES_PASSWORD=YOUR_DATABASE_PASSWORD
POSTGRES_SCHEMA=map
POSTGRES_POOL_MAX=10
POSTGRES_CONNECT_TIMEOUT_MS=10000
POSTGRES_SSL=false

IMPORT_JSON_ON_START=true
MAX_UPLOAD_MB=50
MAP_MAX_WIDTH=4096
MACHINE_MAX_WIDTH=1800

MULTIRES_ENABLED=true
MULTIRES_TILE_SIZE=512
MULTIRES_FALLBACK_SIZE=1024
MULTIRES_TILE_QUALITY=85
MULTIRES_TIMEOUT_MS=1200000

ADMIN_USERNAME=admin
ADMIN_PASSWORD=CHANGE_THIS_ADMIN_PASSWORD
VIEWER_USERNAME=viewer
VIEWER_PASSWORD=CHANGE_THIS_VIEWER_PASSWORD
AUTH_SESSION_HOURS=12
AUTH_COOKIE_SECURE=false
```

### Start the Application

Open PowerShell or Command Prompt in the project folder, then run:

```powershell
docker compose up -d --build
```

### Check the Containers

```powershell
docker compose ps
```

The Power Tool and Nginx containers should show as running or healthy.

### Confirm PostgreSQL Mode

```powershell
curl.exe http://localhost:5057/api/health
```

When PostgreSQL is reachable, the response contains:

```json
"provider": "postgresql"
"status": "connected"
```

If PostgreSQL is temporarily unreachable, the application remains healthy and the response contains:

```json
"provider": "json"
"configuredProvider": "postgresql"
"status": "local-fallback"
"fallback": true
"retrying": true
```

This is expected while the database network is unavailable. The application continues using its local Docker volume and reconnects automatically after network access returns.

### Open the System

On the computer running Docker:

```text
http://localhost:5057
```

From another device on the same network:

```text
http://SERVER_IP:5057
```

Replace `SERVER_IP` with the IP address of the computer running Docker. The Windows firewall and network must allow access to the configured application port.

### Start Again

```powershell
docker compose up -d
```

### Restart the Application

```powershell
docker compose restart
```

### Rebuild After Receiving Updated Files

```powershell
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Stop the Application

```powershell
docker compose down
```

### Check Application Messages

```powershell
docker compose logs --tail=100
```

To follow new messages continuously:

```powershell
docker compose logs -f
```

## Basic Troubleshooting

### The System Does Not Open

Check the containers:

```powershell
docker compose ps
```

View the latest messages:

```powershell
docker compose logs --tail=200
```

If Power Tool is unhealthy, check its backend messages:

```powershell
docker compose logs --tail=200 power-tool
```

### The Application Shows No Existing Records

Check the health response:

```powershell
curl.exe http://localhost:5057/api/health
```

If it shows `"provider":"json"` together with `"fallback":true`, the PostgreSQL server is currently unreachable and the application is safely using its local copy. Reconnect the computer to the database network and wait for the automatic retry.

If `"configuredProvider"` is also `"json"`, add or correct this value in `.env`:

```env
POSTGRES_ENABLED=true
```

Then recreate the containers:

```powershell
docker compose down
docker compose up -d --force-recreate
```

### Database Connection Error

- Confirm that the PostgreSQL server is running and reachable.
- Confirm the host, port, database, user, and password in `.env`.
- Confirm that the PostgreSQL user can access the `app` schema.
- Contact the system owner or database administrator if the connection still fails.

### A QR Code Does Not Open on Another Device

- Confirm that `PUBLIC_APP_URL` uses an address accessible from that device.
- Confirm that the device is connected to the correct network.
- Confirm that the Docker computer's firewall permits the application port.
- Generate the QR code again after correcting `PUBLIC_APP_URL`.

### An Automatic Review Does Not Run

- Confirm that automatic rules are configured for the question and answer.
- Confirm that the submitted answers exactly match the configured options.
- If no matching rule exists, complete the review manually.

### Session Logs Are Empty

- Check `/api/health`. While `"provider":"json"`, sessions are retained in the local fallback data and are added to PostgreSQL after reconnection.
- Wait until the health response shows `"provider":"postgresql"` before checking the PostgreSQL log table.
- Open or refresh the application to create a visitor session.
- Check the table in pgAdmin:

```sql
SELECT *
FROM app."PowerTool-logs"
ORDER BY created_at DESC
LIMIT 50;
```

## Security

- Share Reviewer and Admin credentials only with authorized personnel.
- Keep `.env` private and do not commit it to Git or include it in a public ZIP file.
- Use a strong Admin password with at least 12 characters.
- Do not expose PostgreSQL directly to untrusted networks.
- Do not publish database credentials, private server addresses, or production configuration.
- Sign out after using Reviewer or Admin functions on a shared device.
