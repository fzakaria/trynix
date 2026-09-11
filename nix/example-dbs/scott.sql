-- SCOTT/TIGER: the demo schema Oracle has shipped since the 1980s, as
-- demobld.sql creates it. Fourteen employees in four departments, a
-- manager column that points back at EMP, and the salary grades a
-- textbook range-join is taught on. Transliterated to SQLite: DATE
-- literals as ISO text, NUMBER(7,2) as REAL.
--
-- BONUS is empty in demobld.sql too. It is here because half the
-- exercises written against this schema insert into it.

CREATE TABLE dept (
  deptno INTEGER PRIMARY KEY,
  dname  TEXT NOT NULL,
  loc    TEXT NOT NULL
);

CREATE TABLE emp (
  empno    INTEGER PRIMARY KEY,
  ename    TEXT NOT NULL,
  job      TEXT NOT NULL,
  mgr      INTEGER REFERENCES emp (empno),
  hiredate TEXT NOT NULL,
  sal      REAL NOT NULL,
  comm     REAL,
  deptno   INTEGER NOT NULL REFERENCES dept (deptno)
);

CREATE TABLE salgrade (
  grade INTEGER PRIMARY KEY,
  losal REAL NOT NULL,
  hisal REAL NOT NULL
);

CREATE TABLE bonus (
  ename TEXT NOT NULL,
  job   TEXT NOT NULL,
  sal   REAL,
  comm  REAL
);

INSERT INTO dept (deptno, dname, loc) VALUES
  (10, 'ACCOUNTING', 'NEW YORK'),
  (20, 'RESEARCH',   'DALLAS'),
  (30, 'SALES',      'CHICAGO'),
  (40, 'OPERATIONS', 'BOSTON');

INSERT INTO emp (empno, ename, job, mgr, hiredate, sal, comm, deptno) VALUES
  (7369, 'SMITH',  'CLERK',     7902, '1980-12-17',  800, NULL, 20),
  (7499, 'ALLEN',  'SALESMAN',  7698, '1981-02-20', 1600,  300, 30),
  (7521, 'WARD',   'SALESMAN',  7698, '1981-02-22', 1250,  500, 30),
  (7566, 'JONES',  'MANAGER',   7839, '1981-04-02', 2975, NULL, 20),
  (7654, 'MARTIN', 'SALESMAN',  7698, '1981-09-28', 1250, 1400, 30),
  (7698, 'BLAKE',  'MANAGER',   7839, '1981-05-01', 2850, NULL, 30),
  (7782, 'CLARK',  'MANAGER',   7839, '1981-06-09', 2450, NULL, 10),
  (7788, 'SCOTT',  'ANALYST',   7566, '1982-12-09', 3000, NULL, 20),
  (7839, 'KING',   'PRESIDENT', NULL, '1981-11-17', 5000, NULL, 10),
  (7844, 'TURNER', 'SALESMAN',  7698, '1981-09-08', 1500,    0, 30),
  (7876, 'ADAMS',  'CLERK',     7788, '1983-01-12', 1100, NULL, 20),
  (7900, 'JAMES',  'CLERK',     7698, '1981-12-03',  950, NULL, 30),
  (7902, 'FORD',   'ANALYST',   7566, '1981-12-03', 3000, NULL, 20),
  (7934, 'MILLER', 'CLERK',     7782, '1982-01-23', 1300, NULL, 10);

INSERT INTO salgrade (grade, losal, hisal) VALUES
  (1,  700, 1200),
  (2, 1201, 1400),
  (3, 1401, 2000),
  (4, 2001, 3000),
  (5, 3001, 9999);
