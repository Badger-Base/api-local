export const fixture = {
  courses: [
    { id: "CS101", uuid: "uuid-1", title: "Intro to CS", designation: "COMP SCI 101", full: "COMP SCI 101", subject: "COMP SCI" },
    { id: "MATH221", uuid: "uuid-2", title: "Calculus I", designation: "MATH 221", full: "MATH 221", subject: "MATH" },
    { id: "PSYCH202", uuid: "uuid-3", title: "Intro Psychology", designation: "PSYCH 202", full: "PSYCH 202", subject: "PSYCH" },
  ],

  sections: [
    { sid: "sec-1", usid: "usec-1", cuuid: "uuid-1", status: "OPEN", seats: 30, mode: "In Person" },
    { sid: "sec-2", usid: "usec-2", cuuid: "uuid-1", status: "WAITLISTED", seats: 0, mode: "In Person" },
    { sid: "sec-3", usid: "usec-3", cuuid: "uuid-2", status: "OPEN", seats: 15, mode: "In Person" },
    { sid: "sec-4", usid: "usec-4", cuuid: "uuid-3", status: "OPEN", seats: 20, mode: "Online" },
  ],

  meetings: [
    { usid: "usec-1", secNum: "001", type: "LEC", num: 1 },
    { usid: "usec-1", secNum: "301", type: "DIS", num: 2 },
    { usid: "usec-2", secNum: "002", type: "LEC", num: 1 },
    { usid: "usec-3", secNum: "001", type: "LEC", num: 1 },
  ],
};
