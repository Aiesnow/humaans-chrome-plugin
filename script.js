let state = {};

function init() {
    addEventListeners();
    chrome.storage.local.get(['accessToken', 'nbHours', 'carryOvertime'], async function(config) {
        state.nbHours = config.nbHours || 8;
        state.carryOvertime = config?.carryOvertime !== false;
        document.getElementById('setting-nb-hours').value = state.nbHours;
        document.getElementById('setting-carry-overtime').checked = state.carryOvertime;
        if (config?.accessToken) {
            state.accessToken = config.accessToken
            document.getElementById('setting-access-token').value = state.accessToken;
            await initMainView(state.accessToken);
            document.getElementById('main').classList.remove('hidden');
        } else {
            document.getElementById('settings').classList.remove('hidden');
        }
    });
}

init();

function addEventListeners() {
    document.getElementById('save-settings').addEventListener("click", saveSettings);
    document.getElementById('open-settings').addEventListener("click", openSettings);
    document.getElementById('close-settings').addEventListener("click", closeSettings);
    document.getElementById('first-clock-in-button').addEventListener("click", clockIn);
    document.getElementById('clock-in-button').addEventListener("click", clockIn);
    document.getElementById('clock-out-button').addEventListener("click", clockOut);
}

async function initMainView(accessToken) {
    const user = await fetchUser(accessToken);
    await chrome.storage.local.set({ userId: user.id });
    state.userId = user.id
    await fetchJobTitle(accessToken, state.userId);
    const todayTimeSheets = await fetchTodayTimeSheet(accessToken, state.userId);
    let openedTimesheetId = null;
    let clockedInTime = null;
    let clockedOutTime = null;
    todayTimeSheets.forEach(timesheet => {
        if (timesheet.date === getDate(new Date())) {
            if (!timesheet.endTime) {
                openedTimesheetId = timesheet.id;
                clockedInTime = timesheet.startTime;
            } else if (!clockedOutTime || clockedOutTime.split(':')[0] < timesheet.endTime.split(':')[0]) {
                clockedOutTime = timesheet.endTime;
            }
        }
    });
    setClock(openedTimesheetId, clockedInTime, clockedOutTime);

    void computeWorkedHours(accessToken, user);
}

async function computeWorkedHours(accessToken, user) {
    const {start, end} = getMonthDates();
    const yearStart = new Date(`${start.getFullYear()}-01-01`);

    const timesheets = await fetchTimeSheet(accessToken, state.userId, yearStart, end);

    state.holidays = new Set();
    state.timeAway = [];
    await fetchTimeAway(accessToken, state.userId, start, end);
    await fetchHolidayCalendar(accessToken, user.remoteCountryCode, yearStart, end);
    if (user.remoteRegionCode) {
        await fetchHolidayCalendar(accessToken, `${user.remoteCountryCode}-${user.remoteRegionCode}`, yearStart, end);
    }
    const yearlyOvertime = getOvertime(yearStart, start, timesheets); // Get overtime between start of the month & start of current week
    // Get month stats
    document.getElementById('month-hours').innerHTML = formatNeededAndWorkedHours(getNeededAndWorkedHours(start, end, timesheets, yearlyOvertime.overtimeHours, yearlyOvertime.overtimeMinutes));
    // Get Week stats
    const weekDates = getWeekDates();
    const beforeWeek = new Date(weekDates.start);
    beforeWeek.setDate(beforeWeek.getDate() - 1);
    const monthlyOvertime = getOvertime(state.carryOvertime ? yearStart : start, beforeWeek, timesheets); // Get overtime between start of the month & start of current week
    document.getElementById('week-hours').innerHTML = formatNeededAndWorkedHours(getNeededAndWorkedHours(weekDates.start, weekDates.end, timesheets, monthlyOvertime.overtimeHours, monthlyOvertime.overtimeMinutes));
    // Get day stats
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const weeklyOvertime = getOvertime(state.carryOvertime ? yearStart : weekDates.start, yesterday, timesheets); // Get overtime between start of the month & start of current week
    document.getElementById('day-hours').innerHTML = formatNeededAndWorkedHours(getNeededAndWorkedHours(today, today, timesheets, weeklyOvertime.overtimeHours, weeklyOvertime.overtimeMinutes));
}

async function fetchHolidayCalendar(accessToken, calendarId, startDate, endDate) {
    const path = new URL('https://app.humaans.io/api/public-holidays');
    path.searchParams.set('publicHolidayCalendarId', calendarId);
    path.searchParams.set('date[$gte]', startDate.toISOString().split('T')[0]);
    path.searchParams.set('date[$lte]', endDate.toISOString().split('T')[0]);
    path.searchParams.set('$limit', '250');
    const res=await fetch (path, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
    });
    const result=await res.json();
    result.data.forEach(holiday => {
        state.holidays.add(holiday.date);
    });
}

async function fetchUser(accessToken) {
    const path = 'https://app.humaans.io/api/me';
    const res=await fetch (path, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
    });
    const record=await res.json();
    document.getElementById("profile-firstname").innerHTML=`${record.firstName} ${record.lastName}`;
    document.getElementById("profile-image").src=record.profilePhoto.variants['64'];
    state.workingDays = record.workingDays.map(day => {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        return days.indexOf(day.day);
    });
    return record;
}

async function fetchJobTitle(accessToken, personId=undefined) {
    let path = new URL('https://app.humaans.io/api/job-roles');
    if (personId) {
        path.searchParams.set('personId', personId);
    }
    const res=await fetch (path.toString(), {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
    });
    const record=await res.json();
    document.getElementById("profile-job-title").innerHTML=record.data[0].jobTitle;
}

async function fetchTimeSheet(accessToken, personId, startDate, endDate, skip = 0) {
    const pageSize = 250;
    const path = new URL('https://app.humaans.io/api/timesheet-entries');
    path.searchParams.set('date[$gte]', startDate.toISOString().split('T')[0]);
    path.searchParams.set('date[$lte]', endDate.toISOString().split('T')[0]);
    path.searchParams.set('personId', personId);
    path.searchParams.set('$limit', pageSize.toString());
    path.searchParams.set('$skip', skip.toString());
    const res=await fetch (path.toString(), {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
    });
    const record=await res.json();

    if (record.skip + record.data.length >= record.total) {
        return record.data;
    }
    else {
        return [
            ...record.data,
            ...await fetchTimeSheet(accessToken, personId, startDate, endDate, skip + pageSize)
        ];
    }
}

async function fetchTodayTimeSheet(accessToken, personId) {
    const path = new URL('https://app.humaans.io/api/timesheet-entries');
    path.searchParams.set('personId', personId);
    path.searchParams.set('date', getDate(new Date()));
    const res=await fetch (path.toString(), {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
    });
    const record=await res.json();

    return record.data;
}

async function fetchTimeAway(accessToken, personId, startDate, endDate) {
    const path = new URL('https://app.humaans.io/api/time-away');
    path.searchParams.set('startDate[$gte]', startDate.toISOString().split('T')[0]);
    path.searchParams.set('startDate[$lte]', endDate.toISOString().split('T')[0]);
    path.searchParams.set('$or.endDate[$gte]', startDate.toISOString().split('T')[0]);
    path.searchParams.set('$or.endDate[$lte]', endDate.toISOString().split('T')[0]);
    path.searchParams.set('$limit', '250');
    path.searchParams.set('personId', personId);
    const res=await fetch (path.toString(), {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
    });
    const result=await res.json();
    result.data.forEach(timeAway => {
        timeAway.breakdown.forEach(day => {
            state.timeAway.push(day.period === 'full' ? day.date : `${day.date}half`);
        });
    });
    return result;
}

async function clockIn() {
    const path = 'https://app.humaans.io/api/timesheet-entries';
    const currentDate = new Date();
    const date = getDate(currentDate);
    const startTime = getTime(currentDate);
    const res=await fetch (path, {
        headers: {
            'Authorization': `Bearer ${state.accessToken}`,
            'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
            personId: state.userId,
            date,
            startTime,
        })
    });
    const record=await res.json();
    setClock(record.id, startTime, null);
    return record.id;
}

async function clockOut() {
    const path = `https://app.humaans.io/api/timesheet-entries/${state.currentActiveTimeSheet}`;
    const endTime = getTime(new Date());
    const res=await fetch (path, {
        headers: {
            'Authorization': `Bearer ${state.accessToken}`,
            'Content-Type': 'application/json'
        },
        method: 'PATCH',
        body: JSON.stringify({
            endTime,
        })
    });
    const record=await res.json();
    setClock(null, null, endTime);
    return record.id;
}

function setClock(currentActiveTimeSheet, clockedInTime, clockedOutTime) {
    state.currentActiveTimeSheet = currentActiveTimeSheet;
    state.clockedInTime = clockedInTime;
    state.clockedOutTime = clockedOutTime;
    if (!currentActiveTimeSheet) {
        chrome.action.setIcon({
            path: 'icon.png',
        });
        if (clockedOutTime) {
            document.getElementById('first-clock-in-button').classList.add('hidden');
            document.getElementById('clock-in-button').classList.remove('hidden');
        } else {
            document.getElementById('first-clock-in-button').classList.remove('hidden');
            document.getElementById('clock-in-button').classList.add('hidden');
        }
        document.getElementById('clock-out-button').classList.add('hidden');
    } else {
        chrome.action.setIcon({
            path: 'icon-green.png',
        });
        document.getElementById('first-clock-in-button').classList.add('hidden');
        document.getElementById('clock-in-button').classList.add('hidden');
        document.getElementById('clock-out-button').classList.remove('hidden');
    }
    if (clockedInTime) {
        document.getElementById('clocked-in-at').innerHTML = clockedInTime.slice(0, -3);
    }
    if (clockedOutTime) {
        document.getElementById('clocked-out-at').innerHTML = clockedOutTime.slice(0, -3);
    }
}

function openSettings() {
    document.getElementById('main').classList.add('hidden');
    document.getElementById('settings').classList.remove('hidden');
}

function closeSettings() {
    document.getElementById('settings').classList.add('hidden');
    document.getElementById('main').classList.remove('hidden');
}

function saveSettings() {
    const accessToken = document.getElementById('setting-access-token').value;
    const nbHours = document.getElementById('setting-nb-hours').value;
    const carryOvertime = document.getElementById('setting-carry-overtime').checked;
    chrome.storage.local.set({ accessToken, nbHours, carryOvertime }).then(async () => {
        state.nbHours = nbHours;
        state.carryOvertime = carryOvertime;
        await initMainView(accessToken);
        closeSettings();
    });
}

function getOvertime(start, end, timesheet) {
    let result = getNeededAndWorkedHours(start, end, timesheet);
    const totalMinutes = result.hoursWorkedForPeriod * 60 + result.minutesWorkedForPeriod;
    const overtimeMinutes = totalMinutes - result.hoursNeededForPeriod * 60;
    return {
        overtimeHours: overtimeMinutes / 60 >> 0,
        overtimeMinutes: overtimeMinutes % 60,
    }
}

function getNeededAndWorkedHours(start, end, timesheet, hoursWorkedForPeriod = 0, minutesWorkedForPeriod = 0) {
    let overtimeHours = hoursWorkedForPeriod;
    let overtimeMinutes = minutesWorkedForPeriod;
    let hoursNeededForPeriod = 0;
    for (const day of daysBetween(start, end)) {
        hoursNeededForPeriod += state.nbHours * hourRateForDay(day);
    }
    for(const sheet of timesheet) {
        const now = new Date();
        if ((new Date(sheet.date) >= start && new Date(sheet.date) <= end) || start === end && getDate(start) === sheet.date) {
            if (sheet.duration) {
                hoursWorkedForPeriod += sheet.duration?.hours || 0;
                minutesWorkedForPeriod += sheet.duration?.minutes || 0;
            } else if(!sheet.endTime && sheet.date === getDate(now)) {
                const [startedHours, startedMinutes, startedSeconds] = sheet.startTime.split(':');
                let hoursWorked = now.getHours() - startedHours;
                let minutesWorked = now.getMinutes() - startedMinutes;
                if (minutesWorked < 0) {
                    hoursWorked--;
                    minutesWorked+=60
                }
                hoursWorkedForPeriod += hoursWorked;
                minutesWorkedForPeriod += minutesWorked;
            }
        }
    }
    hoursWorkedForPeriod += Math.floor(Math.abs(minutesWorkedForPeriod) / 60);
    minutesWorkedForPeriod = minutesWorkedForPeriod % 60;
    const percentWorked = (hoursWorkedForPeriod + minutesWorkedForPeriod / 60) / hoursNeededForPeriod * 100;
    return {
        hoursWorkedForPeriod,
        minutesWorkedForPeriod,
        hoursNeededForPeriod,
        percentWorked,
        overtimeHours,
        overtimeMinutes,
    }
}

function formatNeededAndWorkedHours(result) {
    let negativeOvertime = false;
    let negativeHoursWorked = false;
    if(result.overtimeMinutes < 0 || result.overtimeHours < 0) {
        negativeOvertime = true;
    }
    if(result.minutesWorkedForPeriod < 0 || result.hoursWorkedForPeriod < 0) {
        negativeHoursWorked = true;
    }
    return `<span title="Including ${negativeOvertime ? '-' : ''}${Math.abs(result.overtimeHours)}:${(`0${Math.abs(result.overtimeMinutes)}`).slice(-2)} of overtime from last period">
                ${negativeHoursWorked ? '-' : ''}${Math.abs(result.hoursWorkedForPeriod)}:${(`0${Math.abs(result.minutesWorkedForPeriod)}`).slice(-2)} / ${result.hoursNeededForPeriod} (${result.percentWorked.toFixed(2)}%)
            </span>`;
}

function hourRateForDay(date) {
    if (state.holidays.has(getDate(date))) {
        return 0; // Holiday
    }
    if (!state.workingDays.includes(date.getDay())) {
        return 0; // Weekend
    }
    if (state.timeAway.includes(getDate(date))) {
        return 0; // Time away
    }
    if (state.timeAway.includes(`${getDate(date)}half`)) {
        return date <= new Date() ? 0.5 : 0; // Time away half day
    }
    return date <= new Date() ? 1 : 0; // Only past & present days
}

function getWeekDates() {
    let today = new Date();
    let day = today.getDay();
    let daysToSubstract = day === 0 ? 6 : day - 1;
    let start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysToSubstract);
    let end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return {start, end};
}

function getMonthDates() {
    // Get today's date
    var today = new Date();
    // Get the start of the month
    var start = new Date(today.getFullYear(), today.getMonth(), 1);
    // Get the end of the month
    var end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    // Return the start and end dates as an object
    return { start: start, end: end };
}

function* daysBetween(startDate, endDate) {
    let currentDate = startDate;
    while (currentDate <= endDate) {
        yield currentDate;
        currentDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);
    }
}

function getDate(date) {
    return `${date.getFullYear()}-${('0' + (date.getMonth()+1)).slice(-2)}-${('0' + date.getDate()).slice(-2)}`;
}

function getTime(date) {
    return `${('0' + date.getHours()).slice(-2)}:${('0' + date.getMinutes()).slice(-2)}:${('0' + date.getSeconds()).slice(-2)}`
}
