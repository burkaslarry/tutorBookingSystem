Tutor Booking System - Windows x64 installer

1. Extract the entire ZIP into a folder on the Windows computer.
2. Double-click Install.cmd and approve the Windows administrator prompt.
3. If Docker Desktop is missing, the script installs it using winget.
   Finish Docker's setup prompts. WSL/virtualization may require a Windows
   restart; if so, restart and double-click Install.cmd again.
4. Enter an admin password (12+ characters), FPS payee and FPS identifier.
5. The script loads the included image, starts the app and opens:
   http://localhost:8000

Requires Windows 10/11 x64 supported by Docker Desktop, hardware
virtualization, and Linux containers. Windows Server is not supported by
this installer. Installing Docker Desktop for the first time needs internet.
Once Docker is ready, the included application image can be loaded offline.
No Node.js, npm, source code download or Docker build is needed on Windows.

Admin username: admin
Admin password: the password entered during setup
Settings: C:\ProgramData\TutorBookingSystem\booking.env
Database and receipts: Docker named volume tutor-booking-data

Re-run Install.cmd to update the same installation, preserving settings,
bookings and receipts. Existing source-folder/Render data is not imported.
Do not delete the tutor-booking-data volume unless you want to erase data.

The installer adds a task to start Docker Desktop at Windows sign-in.
The app restarts when Docker starts; the PC must stay on for students to use it.
The installer allows port 8000 only from the local subnet on Private networks.
Other devices on that network use http://WINDOWS-LAN-IP:8000.
Public internet access requires a separate HTTPS domain or tunnel.

Logs: docker logs --tail 100 tutor-booking-system
Stop: docker stop tutor-booking-system
Start: docker start tutor-booking-system
